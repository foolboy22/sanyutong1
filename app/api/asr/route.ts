// app/api/asr/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const MODEL = "qwen3-asr-flash";

function pickApiKey() {
  return (
    process.env.DASHSCOPE_API_KEY ||
    process.env.BAILIAN_API_KEY ||
    process.env.QWEN_API_KEY ||
    ""
  );
}

function extFromMime(mime?: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  return "webm";
}

async function getPolicy(apiKey: string) {
  const policyRes = await fetch(
    `${BASE_URL}/uploads?action=getPolicy&model=${encodeURIComponent(MODEL)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const policyJson = await policyRes.json().catch(() => ({}));
  if (!policyRes.ok) {
    throw new Error(`Get upload policy failed: ${JSON.stringify(policyJson)}`);
  }

  const policyData = policyJson?.data || policyJson;
  if (!policyData?.upload_host || !policyData?.upload_dir) {
    throw new Error(`Upload policy format unexpected: ${JSON.stringify(policyJson)}`);
  }
  return policyData;
}

async function uploadToTempOss(policyData: any, fileBuf: Buffer, mimeType: string) {
  const uploadHost = policyData.upload_host;
  const uploadDir = policyData.upload_dir;

  const ext = extFromMime(mimeType);
  const fileName = `asr_${Date.now()}.${ext}`;
  const key = `${uploadDir}/${fileName}`;

  const form = new FormData();
  form.append("OSSAccessKeyId", policyData.oss_access_key_id);
  form.append("Signature", policyData.signature);
  form.append("policy", policyData.policy);
  form.append("x-oss-object-acl", policyData.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", policyData.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  const u8 = new Uint8Array(fileBuf);
form.append("file", new Blob([u8], { type: mimeType }), fileName);


  const upRes = await fetch(uploadHost, { method: "POST", body: form });
  if (!upRes.ok) {
    const t = await upRes.text().catch(() => "");
    throw new Error(`Upload to OSS failed (${upRes.status}): ${t}`);
  }

  return `oss://${key}`;
}

async function callAsr(apiKey: string, ossUrl: string, language: string, context: string) {
  const messages: any[] = [];
  if (context) messages.push({ role: "system", content: [{ text: context }] });
  messages.push({ role: "user", content: [{ audio: ossUrl }] });

  const asrOptions: any = {};
  if (language && language !== "auto") asrOptions.language = language;
  if (language === "zh" || language === "en") asrOptions.enable_itn = true;

  const asrRes = await fetch(`${BASE_URL}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: MODEL,
      input: { messages },
      parameters: { asr_options: asrOptions },
    }),
  });

  const asrJson = await asrRes.json().catch(() => ({}));
  if (!asrRes.ok) {
    throw new Error(`ASR failed (${asrRes.status}): ${JSON.stringify(asrJson)}`);
  }

  const choice = asrJson?.output?.choices?.[0];
  const text =
    choice?.message?.content?.[0]?.text ??
    choice?.message?.content?.map((x: any) => x?.text).filter(Boolean).join("") ??
    "";

  const detectedLang = choice?.message?.annotations?.[0]?.language ?? null;

  return {
    text,
    language: detectedLang,
    seconds: asrJson?.usage?.seconds,
    request_id: asrJson?.request_id,
  };
}

export async function POST(req: Request) {
  try {
    const apiKey = pickApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing API key. Set DASHSCOPE_API_KEY in .env.local" },
        { status: 500 }
      );
    }

    // ✅ 同时支持两种输入：FormData(file) 或 JSON(audioBase64)
    const ct = (req.headers.get("content-type") || "").toLowerCase();

    let audioBuf: Buffer | null = null;
    let mimeType = "audio/webm";
    let language = "auto";
    let context = "";

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file") as File | null;
      if (!file) return NextResponse.json({ error: "missing file" }, { status: 400 });

      mimeType = file.type || mimeType;
      const arr = await file.arrayBuffer();
      audioBuf = Buffer.from(arr);

      language = String(form.get("language") ?? "auto");
      context = String(form.get("context") ?? "");
    } else {
      const body = await req.json().catch(() => ({}));
      const audioBase64 = String(body?.audioBase64 || body?.base64 || "").trim();
      if (!audioBase64) return NextResponse.json({ error: "Missing audioBase64" }, { status: 400 });

      mimeType = String(body?.mimeType || mimeType);
      language = String(body?.language || "auto");
      context = String(body?.context || "");
      audioBuf = Buffer.from(audioBase64, "base64");
    }

    if (!audioBuf || audioBuf.length === 0) {
      return NextResponse.json({ error: "Empty audio" }, { status: 400 });
    }

    // 建议短音频 <= 10MB（更稳）
    if (audioBuf.byteLength > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Audio too large (>10MB). Please record a shorter clip." },
        { status: 413 }
      );
    }

    const policyData = await getPolicy(apiKey);
    const ossUrl = await uploadToTempOss(policyData, audioBuf, mimeType);
    const result = await callAsr(apiKey, ossUrl, language, context);

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
