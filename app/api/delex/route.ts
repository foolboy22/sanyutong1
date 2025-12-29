import { NextResponse } from "next/server";

function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const maybe = text.slice(start, end + 1);
    return JSON.parse(maybe);
  }
  throw new Error("Model output is not valid JSON.");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const input = String(body?.text ?? "").trim();
    const mode = (body?.mode === "full" ? "full" : "fast") as "fast" | "full";

    if (!input) return NextResponse.json({ error: "empty" }, { status: 400 });

    const apiKey = process.env.DASHSCOPE_API_KEY;
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const model = process.env.QWEN_LEX_MODEL || "qwen-plus";

    if (!apiKey) throw new Error("Missing DASHSCOPE_API_KEY");

    const systemFast = `你是德语词典与语法分析器。只处理德语输入，输出严格JSON，不要Markdown，不要多余解释。
任务（FAST 极速）：从输入德语中抽取【名词】与【动词】，只输出“核心词典信息”，要尽量快。
必须输出JSON结构（严格一致）：
{
  "mode":"fast",
  "is_german": true/false,
  "nouns":[{"lemma":"Hund","gender":"der|die|das","plural":"Hunde"}],
  "verbs":[{"infinitive":"gehen","auxiliary":"haben|sein","praesens_3sg":"geht","praeteritum_ich":"ging","partizip_ii":"gegangen","perfekt":"ich bin gegangen"}],
  "sentences":[]
}
规则：
- 名词给 gender + lemma + plural；
- 动词给 infinitive + auxiliary + praesens_3sg(第三人称单数现在时) + praeteritum_ich(我 的单纯过去式) + partizip_ii + perfekt(一句)；
- 不要输出任何变位表（Präsens/Präteritum/Imperativ/Konjunktiv II）；
- 不要输出例句字段（example）；
- nouns/verbs 去重，按重要性排序；数量控制：名词<=10，动词<=6；
- 如果不是德语：is_german=false 且 nouns=[],verbs=[],sentences=[]。`;

    const systemFull = `你是德语词典与语法分析器。只处理德语输入，输出严格JSON，不要Markdown，不要多余解释。
任务（FULL 详情）：输出名词/动词的完整信息（含全变位+例句）。
必须输出JSON结构（严格一致）：
{
  "mode":"full",
  "is_german": true/false,
  "nouns":[
    {"lemma":"Hund","gender":"der|die|das","plural":"Hunde","example":"Der Hund bellt."}
  ],
  "verbs":[
    {
      "infinitive":"gehen",
      "auxiliary":"haben|sein",
      "praesens":{"ich":"","du":"","er_sie_es":"","wir":"","ihr":"","sie_Sie":""},
      "praeteritum":{"ich":"","du":"","er_sie_es":"","wir":"","ihr":"","sie_Sie":""},
      "partizip_ii":"gegangen",
      "perfekt":"ich bin gegangen",
      "imperativ":{"du":"","ihr":"","Sie":""},
      "konjunktiv_ii":{"ich":"","du":"","er_sie_es":"","wir":"","ihr":"","sie_Sie":""},
      "example":"Ich gehe nach Hause."
    }
  ],
  "sentences":["给2-4句例句或改写"]
}
规则：
- 名词lemma用单数主格；gender必须是 der/die/das；plural给常见复数形式；
- 动词：auxiliary按Perfekt选择haben或sein；六个人称必须填全；imperativ三种形式；konjunktiv_ii给常用形式（必要时可用 würde + Inf.）；
- 去重并按重要性排序；数量控制：名词<=12，动词<=8；
- 如果不是德语：is_german=false 且 nouns=[],verbs=[],sentences=[]。`;

    const user = `输入德语：\n${input}\n\n只输出JSON。`;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: mode === "full" ? systemFull : systemFast },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`DashScope error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const json = extractJson(content);

    if (!json.mode) json.mode = mode;

    return NextResponse.json(json);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "unknown error" }, { status: 500 });
  }
}
