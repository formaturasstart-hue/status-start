// Espaço das fotos no servidor (23/11/2026) — roda no GitHub Actions logo depois do vigia (ver vigia.yml).
//
// O entregador de fotos (VPS) mede no /saude: o cache das fotos do Drive (limite de 60 GB; ele mesmo apaga as
// menos usadas), a vitrine das entregas (miniaturas com logo que o separador grava e que só cresce) e o disco
// livre. Aqui guardamos o número atual e um ponto por dia (90 dias) em dados/disco.json, que a página de status
// lê, e mandamos e-mail pela Resend quando o disco fica com pouco espaço: abaixo de 10 GB livres, de novo abaixo
// de 5 GB, e quando volta acima de 15 GB. Destinatários: variável ALERTA_EMAIL (sem ela, só registra no log).
import { readFile, writeFile } from "node:fs/promises";

const ENTREGADOR = (process.env.VIGIA_ENTREGADOR || "").replace(/\/+$/, "");
const STATUS_URL = "https://status.startfotos.com.br";
const ARQ = new URL("../dados/disco.json", import.meta.url);
const AVISO_GB = 10, CRITICO_GB = 5, VOLTOU_GB = 15;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const diaBR = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
const gbBR = (n) => (n == null ? "—" : `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`);

/** Nível do aviso. Só piora (ok → pouco → crítico) abaixo dos limites e só volta a "ok" acima de 15 GB. */
export function nivelDoAviso(antes, livre) {
  if (livre < CRITICO_GB) return "critico";
  if (livre < AVISO_GB) return antes === "critico" ? "critico" : "pouco";
  if (livre > VOLTOU_GB) return "ok";
  return antes; // entre 10 e 15 GB: mantém (evita e-mail indo e voltando)
}

/** Junta a leitura nova ao que já estava guardado. Devolve { dados, gravar, aviso }. */
export function juntar(ant, lido, agora, forcarGravacao = false) {
  const hoje = diaBR(agora);
  const atual = { em: agora, livre_gb: lido.livre_gb, total_gb: lido.total_gb ?? null, cache_gb: lido.cache_gb, limite_gb: lido.limite_gb, vitrine_gb: lido.vitrine_gb ?? null };
  const historico = Array.isArray(ant?.historico) ? ant.historico : [];
  const novoDia = !historico.length || historico[historico.length - 1].dia !== hoje;
  const antes = ant?.alerta ?? "ok";
  const alerta = nivelDoAviso(antes, lido.livre_gb);
  const ultima = ant?.em ? Date.parse(ant.em) : 0;
  // regrava só quando muda algo importante ou de hora em hora (cada gravação vira um commit no GitHub)
  const gravar = forcarGravacao || !ant || novoDia || alerta !== antes || Date.parse(agora) - ultima > 55 * 60_000;
  if (!gravar) return { dados: ant, gravar: false, aviso: null };
  const ponto = { dia: hoje, cache_gb: atual.cache_gb, vitrine_gb: atual.vitrine_gb, livre_gb: atual.livre_gb };
  const hist = novoDia ? [...historico, ponto] : [...historico.slice(0, -1), ponto];
  return { dados: { ...atual, alerta, historico: hist.slice(-90) }, gravar: true, aviso: alerta !== antes ? alerta : null };
}

async function lerDisco() {
  for (let t = 1; t <= 2; t++) {
    try {
      const r = await fetch(`${ENTREGADOR}/saude`, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "vigia-start" } });
      const j = await r.json(); // 503 também traz o corpo (ex.: disco quase cheio)
      if (j && j.disco && typeof j.disco.livre_gb === "number") return j.disco;
      return null;
    } catch {
      if (t < 2) await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return null;
}

async function avisar(nivel, d) {
  const chave = process.env.RESEND_API_KEY;
  const para = (process.env.ALERTA_EMAIL || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!chave || !para.length) return console.log("[disco] sem RESEND_API_KEY ou ALERTA_EMAIL — aviso não enviado:", nivel);
  const de = process.env.EMAIL_REMETENTE || "Status Start <onboarding@resend.dev>";
  const voltou = nivel === "ok";
  const assunto = voltou ? `🟢 Espaço do servidor normalizado (${gbBR(d.livre_gb)} livres)` : `${nivel === "critico" ? "🔴" : "🟠"} Pouco espaço no servidor das fotos: ${gbBR(d.livre_gb)} livres`;
  const texto = voltou
    ? "O disco do servidor voltou a ter espaço folgado."
    : "O disco do servidor da Start (VPS) está ficando cheio. O entregador para de guardar fotos novas com menos de 3 GB livres (continua funcionando, só mais devagar), mas o separador e o Start Atas podem falhar ao gravar. O que mais cresce é a vitrine das entregas, que não se apaga sozinha.";
  const linhas = [
    ["Livre no disco", `${gbBR(d.livre_gb)}${d.total_gb ? ` de ${gbBR(d.total_gb)}` : ""}`],
    ["Fotos do Drive (cópia rápida)", `${gbBR(d.cache_gb)} de ${gbBR(d.limite_gb)}`],
    ["Vitrine das entregas", gbBR(d.vitrine_gb)],
  ];
  const cor = voltou ? "#1f8a4c" : nivel === "critico" ? "#b4232a" : "#b7791f";
  const html = `
<div style="background:#f4f2ee;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#161615">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
    <div style="background:#0e0e0d;color:#f4f2ee;padding:16px 22px;font-weight:900;font-size:20px;letter-spacing:.02em">START <span style="font-weight:400;font-size:11px;letter-spacing:.3em;color:#8f8a82">ALERTA AUTOMÁTICO</span></div>
    <div style="background:${cor};color:#fff;padding:13px 22px;font-weight:700;font-size:15px">${esc(assunto)}</div>
    <div style="padding:18px 22px 22px;font-size:14px;line-height:1.5">
      <p style="margin:0 0 10px">${esc(texto)}</p>
      <table style="width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:13.5px">
        ${linhas.map(([k, v]) => `<tr><td style="padding:7px 0;border-bottom:1px solid #e6e2da;color:#6e6961;width:46%">${esc(k)}</td><td style="padding:7px 0;border-bottom:1px solid #e6e2da">${esc(v)}</td></tr>`).join("")}
      </table>
      <a href="${STATUS_URL}" style="display:inline-block;background:#161615;color:#f4f2ee;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;font-size:13.5px">Ver página de status</a>
    </div>
  </div>
</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: de, to: para, subject: assunto, html, text: `${assunto}\n${texto}\n${linhas.map((l) => l.join(": ")).join("\n")}\n${STATUS_URL}` }),
  });
  console.log("[disco] e-mail", nivel, r.status);
}

async function principal() {
  if (!ENTREGADOR) return console.log("[disco] sem VIGIA_ENTREGADOR — nada a medir");
  const lido = await lerDisco();
  if (!lido) return console.log("[disco] o entregador não respondeu agora — fica para a próxima rodada");
  let ant = null;
  try {
    ant = JSON.parse(await readFile(ARQ, "utf8"));
  } catch {
    ant = null;
  }
  const { dados, gravar, aviso } = juntar(ant, lido, new Date().toISOString());
  console.log(`[disco] livre ${gbBR(lido.livre_gb)} · fotos do Drive ${gbBR(lido.cache_gb)} de ${gbBR(lido.limite_gb)} · vitrine ${gbBR(lido.vitrine_gb)} · aviso ${dados.alerta}`);
  if (aviso) await avisar(aviso, dados);
  if (gravar) await writeFile(ARQ, JSON.stringify(dados, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) await principal();
