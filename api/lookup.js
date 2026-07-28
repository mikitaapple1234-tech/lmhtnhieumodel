export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Chỉ chấp nhận phương thức POST' });
  }

  const { word } = req.body;
  if (!word || !word.trim()) {
    return res.status(400).json({ error: 'Thiếu từ cần tra cứu' });
  }

  const prompt = `Phân tích từ tiếng Trung sau trong bối cảnh chơi game Liên Minh Huyền Thoại (LoL): "${word}".
Hãy trả về DUY NHẤT một chuỗi JSON hợp lệ (không kèm theo bất kỳ markdown hay text nào khác ngoài JSON) với cấu trúc sau:
{
  "word": "${word}",
  "pinyin": "phiên âm pinyin kèm thanh điệu",
  "meaning": "nghĩa tiếng Việt chính xác trong game LoL",
  "note": "ghi chú ngắn gọn về cách dùng hoặc ngữ cảnh trong trận đấu",
  "category": "chọn 1 trong các mục sau: Tên tướng, Kỹ năng / Chiêu thức, Vai trò / Lối chơi, Trang bị / Vật phẩm, Thuật ngữ trận đấu, Từ vựng chung"
}`;

  // 1. Ưu tiên gọi mô hình Gemini 3 / 3.5 thế hệ mới
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textResult) {
          const parsed = JSON.parse(textResult);
          return res.status(200).json(parsed);
        }
      }
    } catch (err) {
      console.error("Gemini 3 lỗi, đang chuyển sang Groq...", err.message);
    }
  }

  // 2. Dự phòng gọi Groq (Llama 3.3) nếu cần
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: "json_object" }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          return res.status(200).json(parsed);
        }
      }
    } catch (err) {
      console.error("Groq lỗi:", err.message);
    }
  }

  return res.status(500).json({ 
    error: 'Không thể kết nối với mô hình AI. Vui lòng kiểm tra lại cấu hình API key trên Vercel.' 
  });
}
