// Vercel serverless function — Kết hợp Gemini 3.5 Flash và Groq (GPT-OSS 120B).
// Đặt 2 biến môi trường trên Vercel: GEMINI_API_KEY và GROQ_API_KEY.
// Lấy Gemini key: https://aistudio.google.com/apikey
// Lấy Groq key: https://console.groq.com/keys

const CATEGORIES = [
  "Tên tướng",
  "Kỹ năng / Chiêu thức",
  "Vai trò / Lối chơi",
  "Trang bị / Vật phẩm",
  "Thuật ngữ trận đấu",
  "Từ vựng chung",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Chỉ hỗ trợ POST" });
    return;
  }

  const { word } = req.body || {};
  if (!word || typeof word !== "string" || !word.trim()) {
    res.status(400).json({ error: "Thiếu từ cần tra" });
    return;
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    res.status(500).json({ error: "Server chưa cấu hình API Key nào (Gemini hoặc Groq)" });
    return;
  }

  const system = `Bạn là trợ lý tra cứu từ vựng tiếng Trung chuyên về game Liên Minh Huyền Thoại (LMHT / League of Legends).
Người dùng sẽ đưa ra một từ hoặc cụm từ tiếng Trung (có thể là thuật ngữ trong game, tên tướng, kỹ năng, hoặc từ vựng thông thường).
Trả lời DUY NHẤT một đối tượng JSON hợp lệ theo đúng định dạng:
{"pinyin": "...", "meaning": "...", "note": "...", "category": "..."}
- "pinyin": phiên âm pinyin có dấu thanh của từ.
- "meaning": nghĩa tiếng Việt, ngắn gọn, súc tích. Nếu từ có liên quan đến LMHT (thuật ngữ game, tên tướng, lối chơi, vị trí, chiêu thức...) hãy ưu tiên nghĩa trong ngữ cảnh đó.
- "note": ghi chú thêm ngắn gọn (cách dùng, ví dụ trong game, hoặc phân biệt với từ dễ nhầm), có thể để chuỗi rỗng nếu không cần thiết.
- "category": chọn CHÍNH XÁC một trong các nhóm sau (viết đúng nguyên văn, không tự đặt tên khác): ${CATEGORIES.map((c) => `"${c}"`).join(", ")}.
  Nếu từ không thuộc rõ về LMHT (từ vựng tiếng Trung thông thường), chọn "Từ vựng chung".`;

  let lastErrorDetail = "";

  function normalize(parsed) {
    return {
      pinyin: parsed.pinyin || "",
      meaning: parsed.meaning || "",
      note: parsed.note || "",
      category: CATEGORIES.includes(parsed.category) ? parsed.category : "Từ vựng chung",
    };
  }

  // BƯỚC 1: Gemini 3.5 Flash (bản Gemini 3 mới nhất, ổn định — gemini-1.x/2.0 đã bị khai tử)
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\nTừ cần tra: ${word.trim()}` }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });

      if (!response.ok) {
        lastErrorDetail = `Gemini lỗi: ${await response.text()}`;
      } else {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
          return res.status(200).json(normalize(parsed));
        }
        lastErrorDetail = "Gemini không trả về nội dung";
      }
    } catch (e) {
      lastErrorDetail = `Lỗi Gemini: ${String(e)}`;
    }
  }

  // BƯỚC 2: Nếu Gemini lỗi/quá tải, chuyển sang Groq (GPT-OSS 120B — llama-3.3 đã bị Groq khai tử)
  if (groqKey) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Từ cần tra: ${word.trim()}` },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          const parsed = JSON.parse(text.trim());
          return res.status(200).json(normalize(parsed));
        }
      } else {
        lastErrorDetail += ` | Groq lỗi: ${await response.text()}`;
      }
    } catch (e) {
      lastErrorDetail += ` | Lỗi Groq: ${String(e)}`;
    }
  }

  res.status(502).json({ error: "Cả Gemini và Groq đều không phản hồi được", detail: lastErrorDetail });
}
