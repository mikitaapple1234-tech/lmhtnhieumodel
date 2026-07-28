// Vercel serverless function — Kết hợp Gemini và Groq API để chống quá tải tuyệt đối.

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

  // BƯỚC 1: Thử các model của Gemini trước
  const geminiModels = ["gemini-1.5-flash", "gemini-1.5-flash-8b"];
  if (geminiKey) {
    for (const model of geminiModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\nTừ cần tra: ${word.trim()}` }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          lastErrorDetail = `Gemini ${model} lỗi: ${errText}`;
          continue;
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;

        const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
        return res.status(200).json({
          pinyin: parsed.pinyin || "",
          meaning: parsed.meaning || "",
          note: parsed.note || "",
          category: CATEGORIES.includes(parsed.category) ? parsed.category : "Từ vựng chung",
        });
      } catch (e) {
        lastErrorDetail = `Lỗi Gemini: ${String(e)}`;
      }
    }
  }

  // BƯỚC 2: Nếu Gemini lỗi/quá tải, chuyển sang Groq (ví dụ dùng Llama 3.3)
  if (groqKey) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Từ cần tra: ${word.trim()}` }
          ],
          response_format: { type: "json_object" }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          const parsed = JSON.parse(text.trim());
          return res.status(200).json({
            pinyin: parsed.pinyin || "",
            meaning: parsed.meaning || "",
            note: parsed.note || "",
            category: CATEGORIES.includes(parsed.category) ? parsed.category : "Từ vựng chung",
          });
        }
      } else {
        const errText = await response.text();
        lastErrorDetail += ` | Groq lỗi: ${errText}`;
      }
    } catch (e) {
      lastErrorDetail += ` | Lỗi Groq: ${String(e)}`;
    }
  }

  // Nếu cả Gemini và Groq đều không thành công
  res.status(502).json({ error: "Hệ thống AI đang quá tải hoàn toàn", detail: lastErrorDetail });
}
