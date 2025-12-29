"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type LexMode = "fast" | "full";
type InputLang = "auto" | "zh" | "en" | "de";

type LexNoun = { lemma: string; gender: "der" | "die" | "das"; plural: string; example?: string };
type Six = { ich: string; du: string; er_sie_es: string; wir: string; ihr: string; sie_Sie: string };

type LexVerb = {
  infinitive: string;
  auxiliary: "haben" | "sein";
  partizip_ii: string;
  perfekt: string;

  // FAST 也会有（你要的）
  praesens_3sg?: string; // er/sie/es
  praeteritum_ich?: string; // ich

  // FULL 时才会有
  praesens?: Six;
  praeteritum?: Six;
  imperativ?: { du: string; ihr: string; Sie: string };
  konjunktiv_ii?: Six;
  example?: string;
};

type LexResult = {
  mode: LexMode;
  is_german: boolean;
  nouns: LexNoun[];
  verbs: LexVerb[];
  sentences?: string[];
};

const TTS_LANG_ZH = "zh-CN";
const TTS_LANG_EN = "en-US";
const TTS_LANG_DE = "de-DE";

export default function Home() {
  const [text, setText] = useState("");
const [isMobile, setIsMobile] = useState(false);
const [autoTranslate, setAutoTranslate] = useState(true);
const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [out, setOut] = useState<{ zh?: string; en?: string; de?: string; error?: string }>({});
  const [lex, setLex] = useState<LexResult | null>(null);

  const [loading, setLoading] = useState(false);
  const [lexLoading, setLexLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // 输入语言（用于 UI；ASR Auto 时会自动切换）
  const [inputLang, setInputLang] = useState<InputLang>("auto");
  const [lastDetectedLang, setLastDetectedLang] = useState<"zh" | "en" | "de" | null>(null);
  // AI 语音输入状态
  const [recState, setRecState] = useState<"idle" | "recording" | "uploading">("idle");
  const [recError, setRecError] = useState("");

  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const canSpeak = useMemo(() => typeof window !== "undefined" && "speechSynthesis" in window, []);

  function speak(t: string, lang: string) {
    const s = t.trim();
    if (!s) return;
    if (!canSpeak) {
      alert("当前浏览器不支持朗读。建议用 Chrome/Edge。");
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  }

  function stopSpeak() {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
  }

  async function copy(t?: string) {
    const s = (t ?? "").trim();
    if (!s) return;
    await navigator.clipboard.writeText(s);
  }

  async function runTranslate(overrideText?: string) {
    const input = (overrideText ?? text).trim();
    if (!input) return;

    setLoading(true);
    setOut({});
    setLex(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const r = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input }),
        signal: controller.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "request failed");
      setOut(data);

      // 翻译完成后：对德语做“极速词典分析”（不 await，避免体感卡住）
      const germanText = String(data?.de ?? "").trim();
      if (germanText) {
        runDeLex(germanText, "fast");
      }
    } catch (e: any) {
      if (e?.name === "AbortError") setOut({ error: "已停止翻译请求。" });
      else setOut({ error: e?.message || "error" });
    } finally {
      setLoading(false);
    }
  }

  async function runDeLex(germanText: string, mode: LexMode) {
    setLexLoading(true);
    try {
      const r = await fetch("/api/delex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: germanText, mode }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "dict request failed");
      setLex(data);
    } catch (e: any) {
      setLex(null);
      setOut((prev) => ({ ...prev, error: `词典分析失败：${e?.message || "error"}` }));
    } finally {
      setLexLoading(false);
    }
  }

  function stopTranslate() {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }

  // ====== AI 语音输入（录音->上传 /api/asr -> 填入输入框） ======
  async function startAIRecord() {
    setRecError("");

    if (!navigator.mediaDevices?.getUserMedia) {
      setRecError("当前浏览器不支持录音。建议用 Chrome/Edge。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Chrome/Edge 一般支持 audio/webm
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        try {
          setRecState("uploading");

          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          const fd = new FormData();
          fd.append("file", blob, "speech.webm");

          fd.append("language", inputLang); // auto/zh/en/de
const r = await fetch("/api/asr", { method: "POST", body: fd });
          const data = await r.json();
          if (!r.ok) throw new Error(data?.error || "ASR failed");

          const textFromAsr = String(data?.text ?? "").trim();
          const rawLang = String(data?.language ?? data?.lang ?? "").trim().toLowerCase();
const langFromAsr: InputLang =
  rawLang.startsWith("zh") ? "zh" : rawLang.startsWith("de") ? "de" : rawLang.startsWith("en") ? "en" : "auto";
          if (textFromAsr) {
  setText(textFromAsr);
  runTranslate(textFromAsr); // ✅ 永远稳定：直接用ASR文本翻译
}
          // Auto 模式：根据 ASR 语言自动切换
          if (langFromAsr === "zh" || langFromAsr === "en" || langFromAsr === "de") {
  setLastDetectedLang(langFromAsr);
}
        } catch (e: any) {
          setRecError(e?.message || "ASR error");
        } finally {
          setRecState("idle");
          // 关麦
          try {
            streamRef.current?.getTracks()?.forEach((t) => t.stop());
          } catch {}
          streamRef.current = null;
        }
      };

      mr.start();
      setRecState("recording");
    } catch (e: any) {
      setRecError(e?.message || "无法开启麦克风");
      setRecState("idle");
    }
  }

  function stopAIRecord() {
    try {
      mediaRecRef.current?.stop();
    } catch {}
  }

  const germanText = out.de ?? "";
useEffect(() => {
  if (!autoTranslate) return;

  const v = text.trim();
  if (!v) return;

  // 录音/识别时不自动翻译，避免抢请求
  if (recState === "recording" || recState === "uploading") return;

  if (typingTimerRef.current) clearTimeout(typingTimerRef.current);

  typingTimerRef.current = setTimeout(() => {
    runTranslate(v);
  }, 600);

  return () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
  };
}, [text, autoTranslate, recState]);
    useEffect(() => {
    const update = () => {
      setIsMobile(window.innerWidth < 900);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
return (
    <main style={{ maxWidth: 1200, margin: "40px auto", padding: 16, fontFamily: "ui-sans-serif" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>三语通</h1>
      <p style={{ opacity: 0.7, marginTop: 6 }}>中 / 英 / 德 三语互译（千问）+ 德语词典（极速/详情两步）+ AI 语音输入</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入任意语言 → 一键三语；或用 AI 语音输入转文字"
        rows={7}
        style={{ width: "100%", marginTop: 16, padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
      />

      <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={inputLang}
          onChange={(e) => setInputLang(e.target.value as any)}
          style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", background: "#fff" }}
          title="输入语言（Auto 不会改变下拉框，只会显示本次识别）"
        >
          <option value="auto">Auto</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="de">Deutsch</option>
        </select>
{inputLang === "auto" && lastDetectedLang && (
  <span style={{ opacity: 0.7, fontSize: 12 }}>
    本次识别：{lastDetectedLang.toUpperCase()}
  </span>
)}
        <button
          onClick={startAIRecord}
          disabled={recState !== "idle"}
          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", background: "#fff" }}
        >
          {recState === "recording" ? "🎙 录音中…" : "🎙 语音输入(AI)"}
        </button>

        <button
          onClick={stopAIRecord}
          disabled={recState !== "recording"}
          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", background: "#fff" }}
        >
          ⏹ 停止录音
        </button>
<label style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
  <input
    type="checkbox"
    checked={autoTranslate}
    onChange={(e) => setAutoTranslate(e.target.checked)}
  />
  自动翻译
</label>

        <button
          onClick={() => runTranslate()}
          disabled={loading || !text.trim()}
          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #111", background: "#111", color: "#fff" }}
        >
          {loading ? "翻译中…" : "一键三语"}
        </button>

        <button
          onClick={stopTranslate}
          disabled={!loading}
          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", background: "#fff" }}
          title="停止翻译请求"
        >
          停止
        </button>

        <button
          onClick={stopSpeak}
          style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", background: "#fff" }}
          title="停止朗读"
        >
          停止朗读
        </button>

        {recState === "uploading" && <span style={{ opacity: 0.7 }}>识别中…</span>}
        {recError && <span style={{ color: "crimson" }}>{recError}</span>}
        {out.error && <span style={{ color: "crimson" }}>{out.error}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr 1.25fr", gap: 12, marginTop: 16 }}>
        <SimpleCard
          title="中文"
          content={out.zh}
          onCopy={() => copy(out.zh)}
          onSpeak={() => speak(out.zh ?? "", TTS_LANG_ZH)}
        />
        <SimpleCard
          title="English"
          content={out.en}
          onCopy={() => copy(out.en)}
          onSpeak={() => speak(out.en ?? "", TTS_LANG_EN)}
        />
        <SimpleCard
          title="Deutsch"
          content={out.de}
          onCopy={() => copy(out.de)}
          onSpeak={() => speak(out.de ?? "", TTS_LANG_DE)}
        />
        <DictCard
          germanText={germanText}
          lex={lex}
          loading={lexLoading}
          onExpand={() => runDeLex(germanText, "full")}
          onSpeakWord={(t) => speak(t, TTS_LANG_DE)}
          onCopyWord={copy}
        />
      </div>

      <p style={{ opacity: 0.6, marginTop: 12, fontSize: 12, lineHeight: 1.5 }}>
        说明：AI 语音输入会录音并上传到后端 /api/asr，再由千问识别转写。若出现“模型不支持音频”之类报错，我们就切换到百炼标准 ASR 接口（更快更便宜）。
      </p>
    </main>
  );
}

function SimpleCard({
  title,
  content,
  onCopy,
  onSpeak,
}: {
  title: string;
  content?: string;
  onCopy: () => void;
  onSpeak?: () => void;
}) {
  return (
    <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, minHeight: 200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {onSpeak && (
            <button
              onClick={onSpeak}
              disabled={!content?.trim()}
              style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}
            >
              发音
            </button>
          )}
          <button
            onClick={onCopy}
            disabled={!content?.trim()}
            style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}
          >
            复制
          </button>
        </div>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", margin: "10px 0 0 0", fontFamily: "inherit", lineHeight: 1.5 }}>
        {content?.trim() ? content : "—"}
      </pre>
    </section>
  );
}

function DictCard({
  germanText,
  lex,
  loading,
  onExpand,
  onSpeakWord,
  onCopyWord,
}: {
  germanText: string;
  lex: LexResult | null;
  loading: boolean;
  onExpand: () => void;
  onSpeakWord: (t: string) => void;
  onCopyWord: (t?: string) => Promise<void>;
}) {
  const hasGerman = germanText.trim().length > 0;
  const isFast = lex?.mode === "fast";
  const isFull = lex?.mode === "full";

  return (
    <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, minHeight: 200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ fontWeight: 700 }}>词典（德语）</div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hasGerman && isFast && (
            <button
              onClick={onExpand}
              disabled={loading}
              style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}
              title="生成全变位 + 例句"
            >
              展开详情
            </button>
          )}

          <div style={{ opacity: 0.7, fontSize: 12 }}>
            {loading ? "分析中…" : !hasGerman ? "等待德语" : isFull ? "详情" : isFast ? "极速" : "—"}
          </div>
        </div>
      </div>

      {!hasGerman && (
        <div style={{ marginTop: 10, opacity: 0.65, lineHeight: 1.5 }}>
          这里只分析德语：你输入任意语言后会生成德语翻译，然后自动先做“极速词典”；需要全变位/例句再点“展开详情”。
        </div>
      )}

      {hasGerman && !lex && !loading && (
        <div style={{ marginTop: 10, opacity: 0.65, lineHeight: 1.5 }}>（未拿到词典结果，可能请求失败。）</div>
      )}

      {lex && lex.is_german === false && (
        <div style={{ marginTop: 10, opacity: 0.65, lineHeight: 1.5 }}>检测到不是德语，因此不生成名词/动词信息。</div>
      )}

      {lex && lex.is_german && (
        <>
          <h3 style={{ marginTop: 12, marginBottom: 6, fontSize: 14 }}>名词（Nomen）</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(lex.nouns ?? []).slice(0, 18).map((n) => (
              <Row
                key={`n-${n.gender}-${n.lemma}`}
                left={`${n.gender} ${n.lemma} — Pl.: ${n.plural}`}
                example={isFull ? n.example : undefined}
                onSpeak={() => onSpeakWord(n.lemma)}
                onCopy={() => onCopyWord(`${n.gender} ${n.lemma} (Pl. ${n.plural})`)}
              />
            ))}
            {(lex.nouns ?? []).length === 0 && <div style={{ opacity: 0.6 }}>（未识别到名词）</div>}
          </div>

          <h3 style={{ marginTop: 14, marginBottom: 6, fontSize: 14 }}>动词（Verb）</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(lex.verbs ?? []).slice(0, 12).map((v) => (
              <VerbBlock key={`v-${v.infinitive}`} v={v} full={isFull} onSpeakWord={onSpeakWord} onCopyWord={onCopyWord} />
            ))}
            {(lex.verbs ?? []).length === 0 && <div style={{ opacity: 0.6 }}>（未识别到动词）</div>}
          </div>

          {isFull && Array.isArray(lex.sentences) && lex.sentences.length > 0 && (
            <>
              <h3 style={{ marginTop: 14, marginBottom: 6, fontSize: 14 }}>例句（更多）</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {lex.sentences.slice(0, 6).map((s, i) => (
                  <Row key={`s-${i}`} left={s} onSpeak={() => onSpeakWord(s)} onCopy={() => onCopyWord(s)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  left,
  example,
  onSpeak,
  onCopy,
}: {
  left: string;
  example?: string;
  onSpeak: () => void;
  onCopy: () => void;
}) {
  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: "8px 10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ lineHeight: 1.4 }}>{left}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onSpeak} style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}>
            发音
          </button>
          <button onClick={onCopy} style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}>
            复制
          </button>
        </div>
      </div>
      {example?.trim() && (
        <div style={{ marginTop: 6, opacity: 0.8, lineHeight: 1.4, fontSize: 12 }}>例：{example}</div>
      )}
    </div>
  );
}

function VerbBlock({
  v,
  full,
  onSpeakWord,
  onCopyWord,
}: {
  v: LexVerb;
  full: boolean;
  onSpeakWord: (t: string) => void;
  onCopyWord: (t?: string) => Promise<void>;
}) {
  const head = `${v.infinitive} — Perfekt: ${v.auxiliary}`;

  const core = [
    `Präsens (er/sie/es): ${v.praesens_3sg ?? "—"}`,
    `Präteritum (ich): ${v.praeteritum_ich ?? "—"}`,
    `Partizip II: ${v.partizip_ii}`,
    `Perfekt: ${v.perfekt}`,
  ].join("\n");

  const hasFull = !!(v.praesens && v.praeteritum && v.imperativ && v.konjunktiv_ii);

  const table =
    full && hasFull
      ? [
          `Präsens: ich ${v.praesens!.ich} | du ${v.praesens!.du} | er/sie/es ${v.praesens!.er_sie_es} | wir ${v.praesens!.wir} | ihr ${v.praesens!.ihr} | sie/Sie ${v.praesens!.sie_Sie}`,
          `Präteritum: ich ${v.praeteritum!.ich} | du ${v.praeteritum!.du} | er/sie/es ${v.praeteritum!.er_sie_es} | wir ${v.praeteritum!.wir} | ihr ${v.praeteritum!.ihr} | sie/Sie ${v.praeteritum!.sie_Sie}`,
          `Partizip II: ${v.partizip_ii}`,
          `Perfekt: ${v.perfekt}`,
          `Imperativ: (du) ${v.imperativ!.du} | (ihr) ${v.imperativ!.ihr} | (Sie) ${v.imperativ!.Sie}`,
          `Konjunktiv II: ich ${v.konjunktiv_ii!.ich} | du ${v.konjunktiv_ii!.du} | er/sie/es ${v.konjunktiv_ii!.er_sie_es} | wir ${v.konjunktiv_ii!.wir} | ihr ${v.konjunktiv_ii!.ihr} | sie/Sie ${v.konjunktiv_ii!.sie_Sie}`,
        ].join("\n")
      : core;

  return (
    <div style={{ border: "1px solid #eee", borderRadius: 10, padding: "8px 10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <div style={{ lineHeight: 1.4, fontWeight: 650 }}>{head}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onSpeakWord(v.infinitive)} style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}>
            发音
          </button>
          <button onClick={() => onCopyWord(`${head}\n${table}`)} style={{ borderRadius: 10, border: "1px solid #ddd", background: "#fff", padding: "6px 10px" }}>
            复制
          </button>
        </div>
      </div>

      <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0 0", fontFamily: "inherit", lineHeight: 1.45, fontSize: 12 }}>
        {table}
      </pre>

      {full && v.example?.trim() && (
        <div style={{ marginTop: 6, opacity: 0.8, lineHeight: 1.4, fontSize: 12 }}>例：{v.example}</div>
      )}
    </div>
  );
}
