// Vercel serverless function — Tích hợp Supabase + Gemini 3.5 Flash & Groq (GPT-OSS 120B)
// Đặt biến môi trường trên Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (hoặc ANON_KEY), GEMINI_API_KEY, GROQ_API_KEY

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const CATEGORIES = [
  "Tên tướng",
  "Kỹ năng / Chiêu thức",
  "Vai trò / Lối chơi",
  "Trang bị / Vật phẩm",
  "Thuật ngữ trận đấu",
  "Từ vựng chung",
];

export default async function handler(req, res) {
  // 1. LẤY TOÀN BỘ TỪ VỰNG (GET method)
  if (req.method === "GET") {
    if (!supabase) {
      return res.status(500).json({ error: "Chưa cấu hình Supabase trên server" });
    }
    const { data, error } = await supabase
      .from('dictionary')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  // 2. TRA CỨU HOẶC THÊM TỪ (POST method)
  if (req.method !== "POST") {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: `Method ${req.method} không được hỗ trợ` });
  }

  const { action, word, id, pinyin, meaning, note, category } = req.body || {};

  // Xử lý XÓA từ (DELETE action)
  if (action === 'delete') {
    if (!id) return res.status(400).json({ error: "Thiếu ID để xoá" });
    if (!supabase) return res.status(500).json({ error: "Chưa cấu hình Supabase" });

    const { error } = await supabase.from('dictionary').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // Xử lý CẬP NHẬT THỦ CÔNG / THÊM THỦ CÔNG (UPDATE / MANUAL ADD action)
  if (action === 'manual_save') {
    if (!word || !word.trim()) return res.status(400).json({ error: "Thiếu từ vựng" });
    if (!supabase) return res.status(500).json({ error: "Chưa cấu hình Supabase" });

    const payload = {
      word: word.trim(),
      pinyin: pinyin || "",
      meaning: meaning || "",
      note: note || "",
      category: CATEGORIES.includes(category) ? category : "Từ vựng chung",
    };

    // Nếu có id thì update, chưa có thì upsert theo cột word
    const { data, error } = await supabase
      .from('dictionary')
      .upsert(id ? { id, ...payload } : payload, { onConflict: 'word' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  // TRA CỨU TỪ BẰNG AI (Mặc định)
  if (!word || typeof word !== "string" || !word.trim()) {
    return res.status(400).json({ error: "Thiếu từ cần tra" });
  }

  const cleanWord = word.trim();

  // Kiểm tra xem từ này đã có trong Supabase chưa để tiết kiệm thời gian & API AI
  if (supabase) {
    const { data: existing } = await supabase
      .from('dictionary')
      .select('*')
      .eq('word', cleanWord)
      .single();

    if (existing) {
      // Đã có trong DB, trả về luôn
      return res.status(200).json(existing);
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  if (!geminiKey && !groqKey) {
    return res.status(500).json({ error: "Server chưa cấu hình API Key AI nào (Gemini hoặc Groq)" });
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
  let aiResult = null;

  function normalize(parsed) {
    return {
      word: cleanWord,
      pinyin: parsed.pinyin || "",
      meaning: parsed.meaning || "",
      note: parsed.note || "",
      category: CATEGORIES.includes(parsed.category) ? parsed.category : "Từ vựng chung",
    };
  }

  // BƯỚC 1: Gemini 3.5 Flash
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${geminiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\nTừ cần tra: ${cleanWord}` }] }],
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
          aiResult = normalize(parsed);
        } else {
          lastErrorDetail = "Gemini không trả về nội dung";
        }
      }
    } catch (e) {
      lastErrorDetail = `Lỗi Gemini: ${String(e)}`;
    }
  }

  // BƯỚC 2: Groq (nếu Gemini không thành công)
  if (!aiResult && groqKey) {
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
            { role: "user", content: `Từ cần tra: ${cleanWord}` },
          ],
          response_format: { type: "json_object" },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          const parsed = JSON.parse(text.trim());
          aiResult = normalize(parsed);
        }
      } else {
        lastErrorDetail += ` | Groq lỗi: ${await response.text()}`;
      }
    } catch (e) {
      lastErrorDetail += ` | Lỗi Groq: ${String(e)}`;
    }
  }

  if (!aiResult) {
    return res.status(502).json({ error: "Cả Gemini và Groq đều không phản hồi được", detail: lastErrorDetail });
  }

  // Lưu kết quả AI vào Supabase tự động
  if (supabase) {
    const { data: saved, error: saveError } = await supabase
      .from('dictionary')
      .upsert(aiResult, { onConflict: 'word' })
      .select()
      .single();

    if (!saveError && saved) {
      return res.status(200).json(saved);
    }
  }

  // Nếu lỡ Supabase không lưu được thì vẫn trả về kết quả AI cho client dùng tạm
  return res.status(200).json(aiResult);
}
