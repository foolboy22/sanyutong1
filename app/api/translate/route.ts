import { NextResponse } from "next/server";

type Target = "Chinese" | "English" | "German";

async function translateOne(text: string, target: Target) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = process.env.QWEN_MT_MODEL || "qwen-mt-flash";

  if (!apiKey) throw new Error("Missing DASHSCOPE_API_KEY");

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: text }],
      translation_options: {
        source_lang: "auto",
        target_lang: target,
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DashScope error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    const input = String(text ?? "").trim();
    if (!input) return NextResponse.json({ error: "empty" }, { status: 400 });

    const [zh, en, de] = await Promise.all([
      translateOne(input, "Chinese"),
      translateOne(input, "English"),
      translateOne(input, "German"),
    ]);

    return NextResponse.json({ zh, en, de });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "unknown error" },
      { status: 500 }
    );
  }
}
