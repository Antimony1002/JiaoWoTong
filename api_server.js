const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config();

const app = express();
const PORT = process.env.PORT || 7860;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// 根路径返回主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'jiaowotong.html'));
});

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// DeepSeek API配置
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'API服务器运行正常' });
});

// 处理文件上传并分析内容
app.post('/api/analyze-files', upload.array('files'), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '未上传文件' });
    }

    // 读取文件内容
    const fileContents = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        fileContents.push({
          name: file.originalname,
          type: file.mimetype,
          content: content.substring(0, 5000) // 限制内容长度
        });
      } catch (readError) {
        console.error(`读取文件${file.originalname}错误:`, readError);
        // 即使读取失败，也继续处理其他文件
        fileContents.push({
          name: file.originalname,
          type: file.mimetype,
          content: `无法读取文件内容: ${readError.message}`
        });
      } finally {
        // 清理临时文件
        try {
          fs.unlinkSync(file.path);
        } catch (unlinkError) {
          console.error(`清理临时文件错误:`, unlinkError);
        }
      }
    }

    // 调用DeepSeek分析文件内容
    try {
      const analysis = await analyzeFilesWithDeepSeek(fileContents);
      
      res.json({
        success: true,
        files: fileContents.map(f => ({ name: f.name, type: f.type })),
        analysis: analysis
      });
    } catch (apiError) {
      console.error('DeepSeek API分析错误:', apiError);
      // API调用失败时，返回文件信息但不包含分析结果
      res.json({
        success: true,
        files: fileContents.map(f => ({ name: f.name, type: f.type })),
        analysis: fileContents.map(f => ({
          name: f.name,
          analysis: `文件分析失败: ${apiError.message || 'API调用错误'}`
        })),
        warning: '文件分析失败，使用备用方案生成模拟卷'
      });
    }
  } catch (error) {
    console.error('文件分析错误:', error);
    res.status(500).json({ 
      error: '文件分析失败',
      details: error.message 
    });
  }
});

// 生成复习计划
app.post('/api/generate-study-plan', async (req, res) => {
  try {
    const { files, targetScore, reviewDays } = req.body;
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '没有文件内容' });
    }

    try {
      const studyPlan = await generateStudyPlanWithDeepSeek(files, targetScore, reviewDays);
      
      res.json({
        success: true,
        studyPlan: studyPlan
      });
    } catch (apiError) {
      console.error('DeepSeek API生成错误:', apiError);
      // API调用失败时，返回备用复习计划
      const fallbackPlan = generateFallbackStudyPlan(files, targetScore, reviewDays);
      
      res.json({
        success: true,
        studyPlan: fallbackPlan,
        warning: 'API调用失败，使用备用方案生成复习计划'
      });
    }
  } catch (error) {
    console.error('生成复习计划错误:', error);
    // 即使出错，也返回备用复习计划
    const fallbackPlan = generateFallbackStudyPlan([], 85, 7);
    
    res.json({
      success: true,
      studyPlan: fallbackPlan,
      warning: '生成失败，使用备用方案'
    });
  }
});

// 生成模拟试卷
app.post('/api/generate-test-paper', async (req, res) => {
  try {
    const { files, targetScore, questionCount, questionType } = req.body;
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: '没有文件内容' });
    }

    try {
      const testPaper = await generateTestPaperWithDeepSeek(files, targetScore, questionCount, questionType);
      
      res.json({
        success: true,
        testPaper: testPaper
      });
    } catch (apiError) {
      console.error('DeepSeek API生成错误:', apiError);
      // API调用失败时，返回备用模拟卷
      const fallbackPaper = generateFallbackTestPaper(files, targetScore, questionCount, questionType);
      
      res.json({
        success: true,
        testPaper: fallbackPaper,
        warning: 'API调用失败，使用备用方案生成模拟卷'
      });
    }
  } catch (error) {
    console.error('生成模拟试卷错误:', error);
    // 即使出错，也返回备用模拟卷
    const fallbackPaper = generateFallbackTestPaper([], 85, 3, 'all');
    
    res.json({
      success: true,
      testPaper: fallbackPaper,
      warning: '生成失败，使用备用方案'
    });
  }
});

// DeepSeek API调用函数
async function callDeepSeekAPI(messages, temperature = 0.7) {
  try {
    // 检查API密钥
    if (!DEEPSEEK_KEY) {
      throw new Error('DeepSeek API密钥未配置');
    }
    
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: messages,
        temperature: temperature,
        max_tokens: 4000
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('DeepSeek API调用错误:', error.response?.data || error.message);
    throw error;
  }
}

// 分析文件内容
async function analyzeFilesWithDeepSeek(files) {
  const fileSummaries = [];
  
  for (const file of files) {
    const prompt = `请分析以下学习资料的内容，提取关键知识点和主题：

文件名: ${file.name}
文件类型: ${file.type}
内容片段: ${file.content}

请提供：
1. 文档的主要主题
2. 关键知识点（3-5个）
3. 文档结构概述
4. 适合的题目类型（选择题、简答题等）`;

    const analysis = await callDeepSeekAPI([
      { role: 'system', content: '你是一位专业的教学助手，擅长分析学习资料' },
      { role: 'user', content: prompt }
    ]);
    
    fileSummaries.push({
      name: file.name,
      analysis: analysis
    });
  }
  
  return fileSummaries;
}

// 生成复习计划
async function generateStudyPlanWithDeepSeek(files, targetScore, reviewDays) {
  const fileSummaries = files.map(f => 
    `文件: ${f.name}\n分析: ${f.analysis || '未分析'}`
  ).join('\n\n');

  const prompt = `作为一位专业的教学规划师，请根据以下学习资料和目标，制定一个详细的复习计划：

学习资料分析：
${fileSummaries}

目标：
- 目标分数：${targetScore}分
- 复习天数：${reviewDays}天

请生成一个详细到每天的学习计划，包括：
1. 每日学习目标
2. 具体学习内容（按小时划分）
3. 重点难点突破
4. 复习建议
5. 自我检测方法

请以JSON格式返回，结构如下：
{
  "plan_title": "个性化复习计划",
  "total_days": ${reviewDays},
  "daily_plans": [
    {
      "day": 1,
      "title": "第一天：基础知识复习",
      "objectives": ["...", "..."],
      "schedule": [
        {"time": "9:00-10:30", "activity": "...", "details": "..."}
      ],
      "key_points": ["...", "..."],
      "difficulty": "中等"
    }
  ]
}`;

  const response = await callDeepSeekAPI([
    { role: 'system', content: '你是一位专业的教学规划师，擅长制定学习计划' },
    { role: 'user', content: prompt }
  ]);

  try {
    // 尝试解析JSON，如果失败则返回原始文本
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || 
                      response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1] || jsonMatch[0]);
    }
    return { raw_response: response };
  } catch (error) {
    return { raw_response: response };
  }
}

// 生成模拟试卷
async function generateTestPaperWithDeepSeek(files, targetScore, questionCount, questionType) {
  const fileSummaries = files.map(f => 
    `文件: ${f.name}\n内容: ${f.content || f.analysis || '未分析'}`
  ).join('\n\n');

  const prompt = `作为一位专业的出题老师，请根据以下学习资料生成一套高质量的模拟试卷：

学习资料：
${fileSummaries}

试卷要求：
- 目标分数：${targetScore}分
- 题目数量：${questionCount}道
- 题目类型：${questionType === 'all' ? '包含选择题、多选题、判断题、简答题' : questionType}

请生成一套完整的试卷，包括：
1. 试卷标题
2. 各部分题目（包含题干、选项、答案、解析）
3. 难度分布
4. 知识点覆盖说明

请以JSON格式返回，结构如下：
{
  "title": "模拟测试卷",
  "questions": [
    {
      "id": 1,
      "type": "single_choice",
      "question": "问题内容",
      "options": ["A. 选项1", "B. 选项2", "C. 选项3", "D. 选项4"],
      "correct_answer": "A",
      "explanation": "答案解析",
      "difficulty": "中等",
      "knowledge_points": ["知识点1", "知识点2"]
    }
  ],
  "analysis": {
    "total_questions": ${questionCount},
    "difficulty_distribution": {"简单": 0.3, "中等": 0.5, "困难": 0.2},
    "knowledge_coverage": ["...", "..."]
  }
}`;

  const response = await callDeepSeekAPI([
    { role: 'system', content: '你是一位专业的出题老师，擅长设计考试题目' },
    { role: 'user', content: prompt }
  ], 0.5); // 降低temperature以获得更稳定的输出

  try {
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/) || 
                      response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1] || jsonMatch[0]);
    }
    return { raw_response: response };
  } catch (error) {
    return { raw_response: response };
  }
}

// 生成备用模拟试卷（当API失败时使用）
function generateFallbackTestPaper(files, targetScore, questionCount, questionType) {
  const isMathContent = files.some(file => 
    file.name.toLowerCase().includes('math') || 
    file.name.toLowerCase().includes('数学') || 
    file.name.toLowerCase().includes('代数') || 
    file.name.toLowerCase().includes('几何')
  );
  
  if (isMathContent) {
    return {
      title: '数学模拟测试卷（备用方案）',
      questions: [
        {
          id: 1,
          type: 'single_choice',
          question: '若函数 f(x) = x² - 3x + 2，则 f(2) 的值为：',
          options: ['A. 0', 'B. 1', 'C. 2', 'D. 3'],
          correct_answer: 'A',
          explanation: '将 x=2 代入函数 f(x) = x² - 3x + 2，得 f(2) = 2² - 3×2 + 2 = 4 - 6 + 2 = 0。',
          difficulty: '简单',
          knowledge_points: ['函数求值', '代数运算']
        },
        {
          id: 2,
          type: 'multiple_choice',
          question: '以下哪些是二次函数的性质？',
          options: ['A. 图像是抛物线', 'B. 最高次数为2', 'C. 一定有两个实根', 'D. 关于对称轴对称'],
          correct_answer: 'A, B, D',
          explanation: '二次函数的图像是抛物线，最高次数为2，关于对称轴对称，但不一定有两个实根（当判别式小于0时无实根）。',
          difficulty: '中等',
          knowledge_points: ['二次函数', '函数性质']
        },
        {
          id: 3,
          type: 'judgment',
          question: 'π 是有理数。',
          options: ['正确', '错误'],
          correct_answer: '错误',
          explanation: 'π 是无理数，不能表示为两个整数的比值。',
          difficulty: '简单',
          knowledge_points: ['无理数', '实数分类']
        }
      ],
      analysis: {
        total_questions: 3,
        difficulty_distribution: { "简单": 0.67, "中等": 0.33, "困难": 0 },
        knowledge_coverage: ['函数求值', '代数运算', '二次函数', '函数性质', '无理数', '实数分类']
      }
    };
  } else {
    return {
      title: '模拟测试卷（备用方案）',
      questions: [
        {
          id: 1,
          type: 'single_choice',
          question: '以下关于计算机网络的说法，正确的是：',
          options: ['A. 计算机网络只能用于传递数据', 'B. 计算机网络由硬件和软件组成', 'C. 计算机网络不需要协议', 'D. 计算机网络只能在局域网中使用'],
          correct_answer: 'B',
          explanation: '计算机网络是由硬件设备和软件系统组成的，用于实现计算机之间的通信和资源共享。',
          difficulty: '简单',
          knowledge_points: ['计算机网络', '网络组成']
        },
        {
          id: 2,
          type: 'multiple_choice',
          question: '以下属于操作系统的是：',
          options: ['A. Windows', 'B. Linux', 'C. Office', 'D. macOS'],
          correct_answer: 'A, B, D',
          explanation: 'Windows、Linux和macOS都是操作系统，而Office是办公软件。',
          difficulty: '简单',
          knowledge_points: ['操作系统', '软件分类']
        },
        {
          id: 3,
          type: 'essay',
          question: '请简述计算机病毒的特点和预防措施。',
          correct_answer: '计算机病毒的特点包括：传染性、潜伏性、破坏性、隐蔽性等。预防措施包括：安装杀毒软件、定期更新系统、不随意打开陌生邮件附件、使用安全的网络环境等。',
          explanation: '本题主要考察对计算机病毒基本概念的理解和预防意识。',
          difficulty: '中等',
          knowledge_points: ['计算机安全', '病毒防护']
        }
      ],
      analysis: {
        total_questions: 3,
        difficulty_distribution: { "简单": 0.67, "中等": 0.33, "困难": 0 },
        knowledge_coverage: ['计算机网络', '网络组成', '操作系统', '软件分类', '计算机安全', '病毒防护']
      }
    };
  }
}

// 生成备用复习计划（当API失败时使用）
function generateFallbackStudyPlan(files, targetScore, reviewDays) {
  const isMathContent = files.some(file => 
    file.name.toLowerCase().includes('math') || 
    file.name.toLowerCase().includes('数学') || 
    file.name.toLowerCase().includes('代数') || 
    file.name.toLowerCase().includes('几何')
  );
  
  const subject = isMathContent ? '数学' : '计算机基础';
  const dailyPlans = [];
  
  for (let i = 1; i <= reviewDays; i++) {
    dailyPlans.push({
      day: i,
      title: `第${i}天：${subject}${i === 1 ? '基础知识' : i === reviewDays ? '综合复习' : '重点内容'}复习`,
      objectives: [
        `掌握${subject}${i === 1 ? '基础知识' : i === reviewDays ? '综合应用' : '核心概念'}`,
        `完成相关练习题目`,
        `整理知识点笔记`
      ],
      schedule: [
        { time: '9:00-10:30', activity: '知识点学习', details: `学习${subject}相关知识点，重点关注基本概念和原理` },
        { time: '10:45-12:00', activity: '例题分析', details: `分析典型例题，理解解题思路` },
        { time: '14:00-15:30', activity: '习题练习', details: `完成相关习题，巩固知识点` },
        { time: '15:45-17:00', activity: '错题整理', details: `整理错题，分析错误原因` },
        { time: '19:00-20:30', activity: '知识点回顾', details: `回顾当天学习内容，强化记忆` }
      ],
      key_points: [
        `${subject}${i === 1 ? '基础知识' : i === reviewDays ? '综合应用' : '核心概念'}`,
        `解题技巧和方法`,
        `常见错误分析`
      ],
      difficulty: i === 1 ? '简单' : i === reviewDays ? '困难' : '中等'
    });
  }
  
  return {
    plan_title: `${subject}个性化复习计划`,
    total_days: reviewDays,
    daily_plans: dailyPlans
  };
}

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API服务器运行在 http://0.0.0.0:${PORT}`);
  console.log('接口说明：');
  console.log('1. POST /api/analyze-files - 分析上传的文件');
  console.log('2. POST /api/generate-study-plan - 生成复习计划');
  console.log('3. POST /api/generate-test-paper - 生成模拟试卷');
});