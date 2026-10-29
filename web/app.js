// Lunar Navigator — dashboard (JS puro, sem build)
const R = 1737400; // raio de referência do DEM (m)
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = (v, d = 1) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

const state = { info: null, bounds: null, lastMap: null, annual: null, busy: false };

// ---------- Geometria: mapa (x, y em m) <-> lat/lon (estereográfica polar sul) ----------
function mapToLatLon(x, y) {
  const rho2 = x * x + y * y, d = rho2 + 4 * R * R;
  const ux = (4 * R * y) / d, uy = (4 * R * x) / d, uz = (rho2 - 4 * R * R) / d;
  return { lat: (Math.asin(uz) * 180) / Math.PI, lon: (Math.atan2(uy, ux) * 180) / Math.PI };
}
function eventToMap(ev, el, b) {
  const r = el.getBoundingClientRect();
  const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
  return { x: b.x_min + fx * (b.x_max - b.x_min), y: b.y_max - fy * (b.y_max - b.y_min), fx, fy };
}
function mapToFraction(x, y, b) {
  return { fx: (x - b.x_min) / (b.x_max - b.x_min), fy: (b.y_max - y) / (b.y_max - b.y_min) };
}

// ---------- API ----------
async function api(path) {
  let res;
  try {
    res = await fetch(path);
  } catch {
    showServerHelp("O servidor parou de responder (ele foi encerrado?).");
    throw new Error("servidor indisponível");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
  return body;
}
const utcValue = () => {
  const v = $("#utc").value;
  return (v.length === 16 ? v + ":00" : v) + "Z";
};

// ---------- Abas ----------
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
    if (t.dataset.tab === "annual") loadAnnual();
  })
);

// ---------- Visualização lado a lado / sobreposta ----------
$$(".seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    const overlay = b.dataset.view === "overlay";
    $("#maps").className = "maps " + (overlay ? "overlay" : "side");
    $("#frame-base figcaption").textContent = overlay
      ? "Topografia LOLA + iluminação (ajuste a opacidade acima)"
      : "Topografia LOLA (relevo sombreado)";
    $("#img-over").classList.toggle("hidden", !overlay || !$("#img-light").src);
  })
);
$("#opacity").addEventListener("input", (e) => {
  const o = e.target.value / 100;
  $("#img-over").style.opacity = o;
  $("#img-light").style.opacity = Math.max(o, 0.15);
});

// ---------- Data: botões ±h ----------
$$(".step-buttons button").forEach((b) =>
  b.addEventListener("click", () => {
    const d = new Date(utcValue());
    d.setUTCHours(d.getUTCHours() + Number(b.dataset.step));
    $("#utc").value = d.toISOString().slice(0, 19);
    if (!state.busy && state.lastMap) run();
  })
);

// ---------- Narrativa do carregamento ----------
const STEPS = [
  ["SPICE: posição aparente do Sol no referencial MOON_ME", 0.02],
  ["Lançando 562 500 raios, um por pixel de 80 m", 0.06],
  ["Avançando os raios em até ~400 passos sobre o relevo LOLA", 0.7],
  ["Comparando cada raio com a altitude (com curvatura lunar)", 0.92],
  ["Calculando a fração do disco solar e gerando a imagem", 1.0],
];
let timerId = null;
function startLoading(mode) {
  const expected = mode === "rapido" ? 0.6 : (state.lastFullTime || 10.5);
  $("#loading").classList.remove("hidden");
  $("#steps").innerHTML = STEPS.map(([s]) => `<li>${s}</li>`).join("");
  const t0 = performance.now();
  timerId = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    $("#timer").textContent = fmt(el, 1);
    const p = Math.min(el / expected, 0.97);
    $("#progress-bar").style.width = `${p * 100}%`;
    $$("#steps li").forEach((li, i) => {
      const start = i === 0 ? 0 : STEPS[i - 1][1], end = STEPS[i][1];
      li.className = p >= end ? "done" : p >= start ? "active" : "";
    });
  }, 100);
}
function stopLoading() {
  clearInterval(timerId);
  $("#progress-bar").style.width = "100%";
  setTimeout(() => $("#loading").classList.add("hidden"), 250);
}

// ---------- Cálculo do mapa ----------
async function run() {
  if (state.busy) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  state.busy = true;
  $("#run").disabled = true;
  $("#run").textContent = "Calculando…";
  startLoading(mode);
  try {
    const m = await api(`/api/map?utc=${encodeURIComponent(utcValue())}&modo=${mode}`);
    if (mode === "completo") state.lastFullTime = m.elapsed_s;
    state.lastMap = m;
    $("#img-light").src = m.image;
    $("#img-over").src = m.image;
    $("#img-over").classList.toggle("hidden", !$("#maps").classList.contains("overlay"));
    $("#cap-light").textContent = `Iluminação — ${m.utc.replace("T", " ").replace("Z", " UTC")}`;
    showResult(m);
    if (state.point) queryPoint(state.point.x, state.point.y);
  } catch (err) {
    if (!$("#server-help")) alert("Erro ao calcular: " + err.message);
  } finally {
    stopLoading();
    state.busy = false;
    $("#run").disabled = false;
    $("#run").textContent = "Calcular iluminação";
  }
}
$("#run").addEventListener("click", run);

function showResult(m) {
  $("#result-card").classList.remove("hidden");
  $("#k-lit").textContent = fmt(m.stats.lit_pct, 1) + "%";
  $("#k-shadow").textContent = fmt(m.stats.shadow_pct, 1) + "%";
  const e0 = m.stats.sun_elevation_min_deg, e1 = m.stats.sun_elevation_max_deg;
  $("#k-elev").textContent = `${fmt(e0, 1)}–${fmt(e1, 1)}°`;
  const px = m.pixels.toLocaleString("pt-BR");
  $("#why-time").innerHTML =
    m.mode === "completo"
      ? `Calculado em <b>${fmt(m.elapsed_s, 1)} s</b>: ${px} raios avançaram juntos por até <b>${m.steps} passos</b>
         cada — centenas de milhões de consultas ao relevo. Pixel a pixel, o mesmo cálculo levaria ~33 h.`
      : `Calculado em <b>${fmt(m.elapsed_s * 1000, 0)} ms</b> usando os horizontes pré-calculados
         (180 direções por pixel): basta comparar a elevação do Sol com o horizonte na direção dele.`;
  if (e1 < 0.3) $("#why-time").innerHTML += " <br>O Sol está quase no horizonte: a maior parte da região fica escura.";
}

// ---------- Mouse: coordenadas e consulta de ponto ----------
$$("[data-map]").forEach((el) => {
  el.addEventListener("mousemove", (ev) => {
    if (!state.bounds) return;
    const p = eventToMap(ev, el, state.bounds), ll = mapToLatLon(p.x, p.y);
    $("#cursor").textContent = `X ${fmt(p.x / 1000, 2)} km · Y ${fmt(p.y / 1000, 2)} km · lat ${fmt(ll.lat, 3)}° · lon ${fmt(ll.lon, 2)}°`;
  });
  el.addEventListener("click", (ev) => {
    if (!state.bounds) return;
    const p = eventToMap(ev, el, state.bounds);
    queryPoint(p.x, p.y);
  });
});

async function queryPoint(x, y) {
  state.point = { x, y };
  const { fx, fy } = mapToFraction(x, y, state.bounds);
  $$("#tab-instant .marker").forEach((mk) => {
    mk.classList.remove("hidden");
    mk.style.left = `${fx * 100}%`;
    mk.style.top = `${fy * 100}%`;
  });
  const ll = mapToLatLon(x, y);
  const card = $("#point-card");
  card.classList.remove("hidden");
  $("#point-body").innerHTML = `<p class="muted">Consultando…</p>`;
  try {
    const p = await api(`/api/illumination?utc=${encodeURIComponent(utcValue())}&lat=${ll.lat}&lon=${ll.lon}`);
    const label = { iluminado: "☀ Iluminado", penumbra: "◑ Penumbra", sombra: "● Em sombra" }[p.status];
    const margin = p.sun_elevation_deg - p.horizon_deg;
    let html = `<div class="point-status ${p.status}">${label} · ${fmt(p.fraction * 100, 0)}% do disco</div>
      <dl class="kv">
        <dt>Lat / lon</dt><dd>${fmt(p.lat, 4)}° / ${fmt(p.lon, 2)}°</dd>
        <dt>Altitude</dt><dd>${fmt(p.height_m, 0)} m</dd>
        <dt>Elevação do Sol</dt><dd>${fmt(p.sun_elevation_deg, 3)}°</dd>
        <dt>Azimute do Sol</dt><dd>${fmt(p.sun_azimuth_deg, 1)}°</dd>
        <dt>Horizonte nessa direção</dt><dd>${fmt(p.horizon_deg, 3)}°</dd>
        <dt>Sol − horizonte</dt><dd>${margin >= 0 ? "+" : ""}${fmt(margin, 3)}°</dd>
      </dl>`;
    if (p.annual) {
      html += `<p class="why"><b>Em ${p.annual.year}:</b> ${fmt(p.annual.illumination_pct, 1)}% do tempo com Sol ·
        maior noite ${fmt(p.annual.longest_night_h / 24, 1)} dias${p.annual.psr ? " · <b class='cyan'>sombra permanente</b>" : ""}</p>`;
    }
    html += `<p class="muted" style="margin:8px 0 0">Ray-casting de 1 pixel: ${fmt(p.elapsed_ms, 0)} ms</p>`;
    $("#point-body").innerHTML = html;
  } catch (err) {
    $("#point-body").innerHTML = `<p class="muted">${err.message}</p>`;
  }
}

// ---------- Análise anual ----------
async function loadAnnual() {
  if (state.annual !== null) return;
  const year = (state.info?.annual_years || []).slice(-1)[0] || 2027;
  try {
    const a = await api(`/api/annual?year=${year}`);
    state.annual = a;
    $("#img-annual").src = a.image;
    $("#annual-cap").textContent = `Iluminação solar em ${a.year} — % do tempo com Sol · ciano = sombra o ano todo`;
    $("#annual-kpis").innerHTML = `
      <div><span>${fmt(a.stats.max_illumination_pct, 1)}%</span><small>pixel mais iluminado</small></div>
      <div><span>${fmt(a.stats.over_50pct_km2, 1)}</span><small>km² com Sol &gt; 50%</small></div>
      <div><span class="cyan">${fmt(a.stats.psr_km2, 0)}</span><small>km² sem Sol no ano</small></div>`;
    $("#annual-meta").textContent = `${a.meta.n_samples} instantes de ${a.meta.start_utc.slice(0, 10)} a ${a.meta.end_utc.slice(0, 10)}, a cada ${a.meta.step_hours} h.`;
    const map = $("#annual-map");
    $("#peaks-body").innerHTML = a.peaks
      .map((p) => `<tr data-rank="${p.rank}"><td>${p.rank}</td><td>${fmt(p.illumination_pct, 1)}%</td>
        <td>${fmt(p.longest_night_h / 24, 1)} d</td><td>${fmt(p.distance_to_psr_km, 1)} km</td></tr>`)
      .join("");
    a.peaks.forEach((p) => {
      const { fx, fy } = mapToFraction(p.x_m, p.y_m, a.bounds);
      const dot = document.createElement("div");
      dot.className = "peak-dot";
      dot.dataset.rank = p.rank;
      dot.textContent = p.rank;
      dot.style.left = `${fx * 100}%`;
      dot.style.top = `${fy * 100}%`;
      dot.title = `#${p.rank}: ${fmt(p.illumination_pct, 1)}% · lat ${p.lat}° lon ${p.lon}° · ${p.height_m} m`;
      map.appendChild(dot);
    });
    $$("#peaks-body tr").forEach((tr) =>
      tr.addEventListener("click", () => {
        $$("#peaks-body tr").forEach((x) => x.classList.toggle("sel", x === tr));
        $$(".peak-dot").forEach((d) => d.classList.toggle("sel", d.dataset.rank === tr.dataset.rank));
      })
    );
  } catch (err) {
    state.annual = false;
    $("#annual-missing").classList.remove("hidden");
    $("#annual-missing p").textContent = err.message;
  }
}

// ---------- Servidor indisponível ----------
function showServerHelp(reason) {
  if ($("#server-help")) return;
  const div = document.createElement("div");
  div.id = "server-help";
  div.innerHTML = `
    <div class="server-help-box">
      <h2>O servidor do Lunar Navigator não está acessível</h2>
      <p>${reason}</p>
      <p>Os cálculos (SPICE + ray-casting) rodam no servidor Python. No terminal, na pasta do projeto:</p>
      <pre>.\\.venv\\Scripts\\Activate.ps1
python scripts\\servidor.py</pre>
      <p>O navegador abrirá sozinho em <a href="http://127.0.0.1:8000/">http://127.0.0.1:8000/</a>.</p>
      <button class="primary" onclick="location.href='http://127.0.0.1:8000/'">Já iniciei — abrir o dashboard</button>
    </div>`;
  document.body.appendChild(div);
}

// ---------- Inicialização ----------
(async function init() {
  if (location.protocol === "file:") {
    showServerHelp("Esta página foi aberta direto do disco (file://), então não há servidor para responder.");
    return;
  }
  try {
    const [info, base] = await Promise.all([api("/api/info"), api("/api/basemap")]);
    state.info = info;
    state.bounds = base.bounds;
    $("#img-base").src = base.image;
    if (!info.horizon_cache) {
      const lbl = $("#mode-fast-label");
      lbl.classList.add("disabled");
      lbl.querySelector("input").disabled = true;
      lbl.querySelector("small").textContent = "Indisponível: rode scripts/mapa_anual.py para gerar o cache.";
    }
  } catch (err) {
    showServerHelp("Não foi possível falar com o servidor: " + err.message);
  }
  $("#img-over").style.opacity = 0.8;
})();
