/*
 * Support chat widget (theme app extension asset). No dependencies, ~6 KB.
 * Posts to the app proxy (/apps/support/chat) so the browser never talks to the app server directly.
 * Everything the agent says is inserted as text, never as HTML.
 */
(function () {
  var root = document.getElementById("sd-support-chat");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";

  var endpoint = root.dataset.endpoint || "/apps/support/chat";
  var greeting = root.dataset.greeting || "Hi! How can I help?";
  var shopName = root.dataset.shopName || "Support";
  var showSteps = root.dataset.debug === "true";
  var storageKey = "sd-support-session";
  var sessionId = null;
  try { sessionId = sessionStorage.getItem(storageKey); } catch (e) {}

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var launcher = el("button", "sd-chat__launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");
  launcher.setAttribute("aria-controls", "sd-chat-panel");
  launcher.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg><span>Chat with us</span>';

  var panel = el("section", "sd-chat__panel");
  panel.id = "sd-chat-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", shopName + " support chat");

  var header = el("header", "sd-chat__header");
  var title = el("div", "sd-chat__title");
  title.appendChild(el("strong", null, shopName));
  title.appendChild(el("span", null, "AI assistant · a person takes over when needed"));
  var close = el("button", "sd-chat__close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close chat");
  header.appendChild(title);
  header.appendChild(close);

  var log = el("div", "sd-chat__log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  var form = el("form", "sd-chat__form");
  var input = el("input", "sd-chat__input");
  input.type = "text";
  input.maxLength = 1000;
  input.placeholder = "Ask about products, sizing, shipping or an order…";
  input.setAttribute("aria-label", "Your message");
  var send = el("button", "sd-chat__send", "Send");
  send.type = "submit";
  form.appendChild(input);
  form.appendChild(send);

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(form);
  root.appendChild(panel);
  root.appendChild(launcher);

  function bubble(who, text) {
    var b = el("div", "sd-chat__msg sd-chat__msg--" + who, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  function cards(products) {
    if (!products || !products.length) return;
    var wrap = el("div", "sd-chat__cards");
    products.forEach(function (p) {
      var a = el("a", "sd-chat__card");
      a.href = p.url;
      if (p.image) {
        var img = el("img");
        img.src = p.image + (p.image.indexOf("?") > -1 ? "&" : "?") + "width=160";
        img.alt = "";
        img.loading = "lazy";
        a.appendChild(img);
      }
      var info = el("span", "sd-chat__card-info");
      info.appendChild(el("span", "sd-chat__card-title", p.title));
      info.appendChild(el("span", "sd-chat__card-price", p.price + (p.inStock ? "" : " · sold out")));
      a.appendChild(info);
      wrap.appendChild(a);
    });
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  function steps(list) {
    if (!showSteps || !list || !list.length) return;
    var d = el("details", "sd-chat__steps");
    d.appendChild(el("summary", null, list.length + " tool call" + (list.length > 1 ? "s" : "")));
    list.forEach(function (s) { d.appendChild(el("div", null, s.tool + " → " + s.summary)); });
    log.appendChild(d);
  }

  function open(state) {
    panel.hidden = !state;
    launcher.setAttribute("aria-expanded", String(state));
    if (state) {
      if (!log.childNodes.length) bubble("agent", greeting);
      input.focus();
    }
  }
  launcher.addEventListener("click", function () { open(panel.hidden); });
  close.addEventListener("click", function () { open(false); launcher.focus(); });
  panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { open(false); launcher.focus(); } });

  var busy = false;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = "";
    bubble("user", text);
    var typing = bubble("agent sd-chat__msg--typing", "…");
    send.disabled = true;

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message: text, sessionId: sessionId }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        typing.remove();
        if (!res.ok) { bubble("agent", res.body.error || "Something went wrong. Please try again."); return; }
        sessionId = res.body.sessionId;
        try { sessionStorage.setItem(storageKey, sessionId); } catch (e) {}
        steps(res.body.steps);
        bubble("agent", res.body.message);
        cards(res.body.products);
        if (res.body.handoff) bubble("system", "Handed to the support team · ticket " + res.body.handoff.ticketId);
      })
      .catch(function () {
        typing.remove();
        bubble("agent", "I can't connect right now. Please email us and we'll help.");
      })
      .finally(function () { busy = false; send.disabled = false; input.focus(); });
  });
})();
