// Vigia da Start — roda no GitHub Actions a cada 5 min (ver .github/workflows/vigia.yml).
// Testa cada serviço (até 3 tentativas, para não dar alarme falso), grava mudanças em
// dados/status.json e manda e-mail pela Resend quando um serviço cai ou volta.
import { readFile, writeFile } from "node:fs/promises";

const SITE = process.env.VIGIA_SITE || "https://albuns.startfotos.com.br";
const STATUS_URL = "https://status.startfotos.com.br";
export const SERVICOS = [
  { slug: "site", nome: "Site e painel da equipe", url: `${SITE}/login` },
  { slug: "galeria", nome: "Galeria do formando", url: `${SITE}/api/saude?s=galeria` },
  { slug: "fotos", nome: "Fotos", url: `${SITE}/api/saude?s=fotos` },
  { slug: "escolha", nome: "Escolha de fotos e aprovação", url: `${SITE}/api/saude?s=escolha` },
  { slug: "banco", nome: "Banco de dados", url: `${SITE}/api/saude?s=banco` },
  { slug: "emails", nome: "E-mails", url: `${SITE}/api/saude?s=emails` },
];
const ARQ = new URL("../dados/status.json", import.meta.url);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function testar(s) {
  let ultimo = "";
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "vigia-start" }, redirect: "follow" });
      if (r.ok) return { ok: true };
      ultimo = r.status >= 500 ? `Erro no servidor (${r.status})` : `Página respondeu com erro (${r.status})`;
    } catch (e) {
      ultimo = e?.name === "TimeoutError" ? "Sem resposta do servidor (30 s)" : "Sem resposta do servidor";
    }
    if (t < 3) await espera(15_000);
  }
  return { ok: false, motivo: ultimo };
}

const hora = (iso) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
function duracao(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

async function avisar(caiu, servico, linhas, outros) {
  const chave = process.env.RESEND_API_KEY;
  const para = (process.env.ALERTA_EMAIL || "formaturasstart@gmail.com").split(",").map((x) => x.trim()).filter(Boolean);
  const de = process.env.EMAIL_REMETENTE || "Status Start <onboarding@resend.dev>";
  if (!chave) return console.log("[vigia] sem RESEND_API_KEY — e-mail não enviado:", caiu ? "caiu" : "voltou", servico);
  const assunto = caiu ? `🔴 Fora do ar: ${servico}` : `🟢 Voltou: ${servico} (fora por ${linhas[0][1]})`;
  const html = `
<div style="background:#f4f2ee;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#161615">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
    <div style="background:#0e0e0d;color:#f4f2ee;padding:16px 22px;font-weight:900;font-size:20px;letter-spacing:.02em">START <span style="font-weight:400;font-size:11px;letter-spacing:.3em;color:#8f8a82">ALERTA AUTOMÁTICO</span></div>
    <div style="background:${caiu ? "#b4232a" : "#1f8a4c"};color:#fff;padding:13px 22px;font-weight:700;font-size:15px">${caiu ? "🔴" : "🟢"} ${esc(servico)} ${caiu ? "está fora do ar" : "voltou"}</div>
    <div style="padding:18px 22px 22px;font-size:14px;line-height:1.5">
      <p style="margin:0 0 10px">${caiu ? "O vigia testou 3 vezes e não teve resposta. Ele continua testando a cada 5 minutos e avisa quando voltar." : "Tudo normal de novo."}</p>
      <table style="width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:13.5px">
        ${[...linhas, ...(outros ? [["Outros serviços", outros]] : [])].map(([k, v]) => `<tr><td style="padding:7px 0;border-bottom:1px solid #e6e2da;color:#6e6961;width:42%">${esc(k)}</td><td style="padding:7px 0;border-bottom:1px solid #e6e2da">${esc(v)}</td></tr>`).join("")}
      </table>
      <a href="${STATUS_URL}" style="display:inline-block;background:#161615;color:#f4f2ee;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;font-size:13.5px">Ver página de status</a>
    </div>
    <div style="padding:10px 22px 16px;font-size:12px;color:#6e6961">Você recebe este e-mail porque está cadastrado nos alertas do sistema Start.</div>
  </div>
</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: de, to: para, subject: assunto, html, text: `${assunto}\n${linhas.map((l) => l.join(": ")).join("\n")}\n${STATUS_URL}` }),
  });
  console.log("[vigia] e-mail", caiu ? "caiu" : "voltou", servico, r.status);
}

if (process.env.VIGIA_TESTE === "true") {
  await avisar(true, "Teste do vigia", [["Serviço", "Teste do vigia (pode ignorar)"], ["Desde", hora(new Date().toISOString())], ["Motivo", "e-mail de teste pedido no GitHub"]], "todos operando");
  process.exit(0);
}

const dados = JSON.parse(await readFile(ARQ, "utf8"));
const agora = new Date().toISOString();
dados.inicio ??= agora;
dados.estado ??= {};
dados.incidentes ??= [];
let mudou = false;

const resultados = await Promise.all(SERVICOS.map(async (s) => [s, await testar(s)]));
const foraAgora = resultados.filter(([, r]) => !r.ok).map(([s]) => s.nome);
for (const [s, r] of resultados) {
  const antes = dados.estado[s.slug] ?? "ok";
  const depois = r.ok ? "ok" : "fora";
  console.log(`[vigia] ${s.nome}: ${depois}${r.motivo ? ` (${r.motivo})` : ""}`);
  if (antes === depois) continue;
  mudou = true;
  dados.estado[s.slug] = depois;
  const outros = SERVICOS.filter((x) => x.slug !== s.slug).map((x) => x.nome);
  if (depois === "fora") {
    dados.incidentes.push({ servico: s.slug, inicio: agora, fim: null, motivo: r.motivo });
    const ok = outros.filter((n) => !foraAgora.includes(n));
    await avisar(true, s.nome, [["Serviço", s.nome], ["Desde", hora(agora)], ["Motivo", r.motivo]], ok.length === outros.length ? "todos operando" : `também fora: ${outros.filter((n) => foraAgora.includes(n)).join(", ")}`);
  } else {
    const inc = [...dados.incidentes].reverse().find((i) => i.servico === s.slug && !i.fim);
    if (inc) inc.fim = agora;
    const ms = inc ? Date.parse(agora) - Date.parse(inc.inicio) : 0;
    await avisar(false, s.nome, [["Ficou fora", duracao(ms)], ["Voltou em", hora(agora)]]);
  }
}

// guarda só ~100 dias de quedas
const limite = Date.now() - 100 * 86400_000;
const antesN = dados.incidentes.length;
dados.incidentes = dados.incidentes.filter((i) => !i.fim || Date.parse(i.fim) > limite);
if (dados.incidentes.length !== antesN) mudou = true;

// "última verificação": grava a cada mudança ou, no máximo, uma vez por hora (para não encher o histórico)
const ultima = dados.ultima_verificacao ? Date.parse(dados.ultima_verificacao) : 0;
if (mudou || Date.now() - ultima > 55 * 60_000) {
  dados.ultima_verificacao = agora;
  await writeFile(ARQ, JSON.stringify(dados, null, 2) + "\n");
}
