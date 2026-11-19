(function () {
  "use strict";

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var storage = vendetta.plugin.storage;
  var showToast = vendetta.ui.toasts.showToast;

  var NAME = "Grammify";
  var MAX_CHARS = 1500;
  var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  var GEMINI_MODEL = "gemini-3.5-flash-lite";

  var PROTECT = new RegExp(
    [
      "```[\\s\\S]*?```",
      "`[^`\\n]*`",
      "<[^>\\n]+>",
      "https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?)\\]]",
      "(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|br|io|gg|me|app|dev|tv|co|ly|to|xyz|info|gov|edu|ai|us|uk|pt|de|fr|es|it|jp|ru|cc|ws|be|link|site|online)\\b(?:[\\/?#][^\\s<>]*[^\\s<>.,;:!?)\\]])?",
      "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
      "@(?:everyone|here)\\b",
      "@\\w+(?:\\.\\w+)*",
      "#[\\w-]+",
      ":[A-Za-z0-9_]+:",
      "\\d+(?:[.,:\\/-]\\d+)+",
      "[\\u2600-\\u27bf\\u2b00-\\u2bff\\ufe0f\\u200d]",
      "[\\ud83c-\\ud83e][\\udc00-\\udfff]",
    ].join("|"),
    "gi"
  );
  var MARKER = /\u00a7\d+\u00a7/g;
  var TOKEN = new RegExp("[^\\s!-\\/:-@\\[-`{-~]+", "g");
  var GAP_CHAR = /[\s.,;:~]/;
  var ACCENTED = "áàâãäåéèêëíìîïóòôõöúùûüçñ";
  var PLAIN = "aaaaaaeeeeiiiiooooouuuucn";

  var PROMPT = [
    "You proofread chat messages written in Brazilian Portuguese. The text was typed without accents, punctuation or capital letters. Return the SAME message, corrected. You may change ONLY these things:",
    "1) Accents, cedilla and crase (à, às, àquele), following Brazilian Portuguese grammar. Read the whole sentence to choose between e/é, esta/está, ja/já, a/à. Words in ALL CAPS also get accents (VOCÊ).",
    "2) Capital letters: only the first letter of the message, the first letter after a period, question mark or exclamation mark, and proper nouns (people, places, brands). After a comma, semicolon or colon the next word stays lowercase unless it is a proper noun.",
    "3) Punctuation: use periods, commas, semicolons and colons as Brazilian Portuguese grammar requires; use a tilde (~) only when it fits. A period may go in the MIDDLE of the text to separate sentences (the next sentence starts with a capital letter) as well as at the end. If the text already has punctuation that is wrong or unnecessary, REMOVE, REPLACE or MOVE it. Leave out the final period only when the sentence is clearly a question (no period and no question mark).",
    "ALL CAPS: words or passages the user already wrote in capitals stay in capitals, never lowercase them. If the whole message is in capitals, return it entirely in capitals (only accents and punctuation change). Never capitalize a word that was lowercase, except the initial letter when rule 2 asks for it.",
    "FORBIDDEN: changing, removing, adding, joining, splitting or reordering words; fixing slang, abbreviations (vc, tb, blz, kkk) or typos; changing the tone; adding emojis, exclamation marks, question marks or any symbol other than . , ; : ~ ; touching porque/por que/porquê, mas/mais, a/há. Question marks and exclamation marks already in the text stay exactly where they are.",
    "If the text is not Portuguese, return it unchanged. Keep line breaks and the \u00a7number\u00a7 markers exactly where they are. Reply with the final text only, no quotes and no comments.",
    "EXAMPLES (input => output):",
    "oi tudo bem com voce => Oi, tudo bem com você",
    "nao sei se vou amanha => Não sei se vou amanhã.",
    "comprei pao leite e ovos no mercado => Comprei pão, leite e ovos no mercado.",
    "cheguei em casa agora vou tomar banho depois a gente conversa => Cheguei em casa agora. Vou tomar banho, depois a gente conversa.",
    "eu, fui ao mercado. e comprei pao => Eu fui ao mercado e comprei pão.",
    "fui a escola hoje => Fui à escola hoje.",
    "ta MUITO quente hoje => Tá MUITO quente hoje.",
    "VOU SAIR AGORA => VOU SAIR AGORA.",
    "ENTAO VOCE NAO VAI => ENTÃO, VOCÊ NÃO VAI.",
    "mano que loucura isso ne => Mano, que loucura isso, né.",
    "kkkk => kkkk",
  ].join("\n");

  var G = (function () {
    try {
      if (typeof globalThis !== "undefined") return globalThis;
    } catch (e) {}
    try {
      if (typeof global !== "undefined") return global;
    } catch (e) {}
    return {};
  })();
  var instanceId = String(Date.now()) + "-" + String(Math.random()).slice(2);
  var alive = false;
  var undoList = [];
  var queue = Promise.resolve();
  var pending = 0;
  var inFlight = [];
  var blockedUntil = 0;
  var lastToast = 0;
  var cache = {};
  var cacheKeys = [];

  function toast(text) {
    try {
      showToast(text);
    } catch (e) {}
  }

  function missing() {
    return ["apiUrl", "apiKey", "model"].filter(function (k) {
      return !storage[k];
    });
  }

  function isConfigured() {
    return missing().length === 0 && String(storage.apiUrl).indexOf("https://") === 0;
  }

  function count(re, s) {
    var m = s.match(re);
    return m ? m.length : 0;
  }

  function stripAccents(s) {
    try {
      if (s.normalize) s = s.normalize("NFD");
    } catch (e) {}
    return s.replace(/[\u0300-\u036f]/g, "").replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñ]/g, function (c) {
      return PLAIN.charAt(ACCENTED.indexOf(c));
    });
  }

  function wordKey(s) {
    return stripAccents(s.toLowerCase());
  }

  function skipReason(text) {
    if (!text.replace(/\s/g, "")) return "empty";
    if (text.length > MAX_CHARS) return "too long";
    if (/^(s\/|\+:|\/)/.test(text)) return "app command";
    if (/^\s*(?:k{2,}|(?:ha){2,}h?|(?:he){2,}h?|(?:rs)+)\s*$/i.test(text)) return "laughter";
    if (Date.now() < blockedUntil) return "api limit";
    return null;
  }

  function cancelPending() {
    var list = inFlight.slice();
    list.forEach(function (item) {
      try {
        item.cancel();
      } catch (e) {}
    });
    return list.length;
  }

  function markLimit(err) {
    var s = Number(err && err.wait);
    var ms = s > 0 && s <= 3600 ? s * 1000 : 60000;
    blockedUntil = Date.now() + ms;
    toast(NAME + ": API limit reached, sending without correction for " + Math.round(ms / 1000) + "s");
  }

  function notifyFailure(err) {
    var reason = String((err && err.message) || err);
    if (reason === "cancelled") return;
    var now = Date.now();
    if (now - lastToast < 8000) return;
    lastToast = now;
    toast(NAME + ": sent as typed (" + reason.slice(0, 40) + ")");
  }

  function httpError(status, body, retryAfter) {
    body = body || "";
    var limited = status === 429 || /RESOURCE_EXHAUSTED/.test(body);
    var e = new Error(limited ? "API limit reached (HTTP " + status + ")" : "HTTP " + status);
    var m = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)/.exec(body);
    e.rateLimited = limited;
    e.wait = Number(retryAfter) > 0 ? Number(retryAfter) : m ? Math.ceil(Number(m[1])) : 0;
    return e;
  }

  function callApi(text) {
    if (!isConfigured()) return Promise.reject(new Error("not configured"));
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var entry = { cancel: null };

    var request = fetch(storage.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + storage.apiKey,
      },
      body: JSON.stringify({
        model: storage.model,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (r) {
        if (!r.ok) {
          var wait = null;
          try {
            wait = r.headers && r.headers.get ? r.headers.get("retry-after") : null;
          } catch (e) {}
          return r.text().then(
            function (body) {
              throw httpError(r.status, body, wait);
            },
            function () {
              throw httpError(r.status, "", wait);
            }
          );
        }
        return r.json();
      })
      .then(function (d) {
        var c = d && d.choices && d.choices[0];
        var t = c && c.message && c.message.content;
        if (typeof t !== "string" || !t) throw new Error("empty reply");
        return t;
      });

    var cancelled = new Promise(function (_, reject) {
      entry.cancel = function () {
        try {
          if (controller) controller.abort();
        } catch (e) {}
        reject(new Error("cancelled"));
      };
    });
    inFlight.push(entry);

    function done() {
      var i = inFlight.indexOf(entry);
      if (i >= 0) inFlight.splice(i, 1);
    }

    return Promise.race([request, cancelled]).then(
      function (v) {
        done();
        return v;
      },
      function (e) {
        done();
        throw e;
      }
    );
  }

  function splitText(text) {
    var tokens = [];
    var gaps = [];
    var last = 0;
    var m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text)) !== null) {
      gaps.push(text.slice(last, m.index));
      tokens.push(m[0]);
      last = m.index + m[0].length;
    }
    gaps.push(text.slice(last));
    return { tokens: tokens, gaps: gaps };
  }

  function mergeGap(inGap, outGap, leading) {
    var wanted = inGap.replace(/[\s.,;:~]/g, "");
    var pos = 0;
    var res = "";
    var dropped = false;
    for (var i = 0; i < outGap.length; i++) {
      var ch = outGap.charAt(i);
      if (GAP_CHAR.test(ch)) res += ch;
      else if (pos < wanted.length && ch === wanted.charAt(pos)) {
        res += ch;
        pos++;
      } else dropped = true;
    }
    if (pos < wanted.length) return inGap;
    if (dropped) res = res.replace(/[ \t]+/g, " ").replace(/ +([.,;:~])/g, "$1");
    res = res.replace(/([?!])\.+/g, "$1");
    if (count(/\n/g, res) !== count(/\n/g, inGap)) return inGap;
    if (/\s/.test(inGap) && !/\s/.test(res)) return inGap;
    var marks = count(/[.,;:~]/g, res);
    var marksIn = count(/[.,;:~]/g, inGap);
    if (marks > Math.max(3, marksIn)) return inGap;
    if (leading && marks > marksIn) return inGap;
    return res;
  }

  function mergeReply(input, reply) {
    if (typeof reply !== "string") return null;
    reply = reply.replace(/^\s+|\s+$/g, "");
    try {
      if (reply.normalize) reply = reply.normalize("NFC");
    } catch (e) {}
    var a = splitText(input);
    var b = splitText(reply);
    if (!b.tokens.length || a.tokens.length !== b.tokens.length) return null;
    var changed = 0;
    var words = [];
    for (var i = 0; i < a.tokens.length; i++) {
      var original = a.tokens[i];
      var fixed = b.tokens[i];
      if (wordKey(fixed) === wordKey(original)) {
        if (/^porque$/i.test(original)) fixed = fixed.replace(/ê/g, "e").replace(/Ê/g, "E");
        words.push(fixed);
      } else {
        changed++;
        words.push(original);
      }
    }
    if (changed * 3 > words.length) return null;
    var out = "";
    for (var j = 0; j < words.length; j++) {
      out += mergeGap(a.gaps[j], b.gaps[j], j === 0) + words[j];
    }
    return out + mergeGap(a.gaps[words.length], b.gaps[words.length], false);
  }

  function isLetter(c) {
    return c.toLowerCase() !== c.toUpperCase();
  }

  function isUpper(c) {
    return c !== c.toLowerCase();
  }

  function atSentenceStart(before) {
    return /(^|[.!?]["')\]]*\s+|\n\s*)$/.test(before);
  }

  function adjustCase(input, output) {
    var letters = [];
    var i;
    for (i = 0; i < input.length; i++) {
      if (isLetter(input.charAt(i))) letters.push(input.charAt(i));
    }
    var out = "";
    var k = 0;
    i = 0;
    while (i < output.length) {
      var c = output.charAt(i);
      if (!isLetter(c)) {
        out += c;
        i++;
        continue;
      }
      var start = i;
      var k0 = k;
      while (i < output.length && isLetter(output.charAt(i))) {
        i++;
        k++;
      }
      var chars = output.slice(start, i).split("");
      var hadUpper = false;
      for (var j = 0; j < chars.length; j++) {
        var e = letters[k0 + j];
        if (e === undefined) return output;
        if (isUpper(e)) {
          hadUpper = true;
          chars[j] = chars[j].toUpperCase();
        }
      }
      var word = chars.join("");
      if (!hadUpper && word.length >= 2 && word === word.toUpperCase()) {
        word = word.toLowerCase();
        if (atSentenceStart(out)) word = word.charAt(0).toUpperCase() + word.slice(1);
      }
      out += word;
    }
    if (k !== letters.length) return output;
    return out;
  }

  function restore(text, kept) {
    kept.forEach(function (original, i) {
      text = text.split("\u00a7" + i + "\u00a7").join(original);
    });
    return text;
  }

  function remember(k, v) {
    if (cache[k] === undefined) {
      cacheKeys.push(k);
      if (cacheKeys.length > 40) delete cache[cacheKeys.shift()];
    }
    cache[k] = v;
  }

  function correct(text) {
    var lead = /^\s*/.exec(text)[0];
    var trail = /\s*$/.exec(text)[0];
    var core = text.slice(lead.length, text.length - trail.length);
    var kept = [];
    var masked = core.replace(PROTECT, function (m) {
      kept.push(m);
      return "\u00a7" + (kept.length - 1) + "\u00a7";
    });
    if (!/[A-Za-z\u00c0-\u00ff]/.test(masked.replace(MARKER, ""))) return Promise.resolve(text);
    var cacheKey = "k" + masked;
    if (cache[cacheKey] !== undefined) return Promise.resolve(lead + restore(cache[cacheKey], kept) + trail);
    return callApi(masked).then(
      function (reply) {
        var merged = mergeReply(masked, reply);
        if (!merged) return text;
        merged = adjustCase(masked, merged);
        blockedUntil = 0;
        remember(cacheKey, merged);
        return lead + restore(merged, kept) + trail;
      },
      function (err) {
        if (err && err.rateLimited) markLimit(err);
        else notifyFailure(err);
        return text;
      }
    );
  }

  function isActive() {
    if (!alive) return false;
    if (G.__grammify && G.__grammify.id !== instanceId) return false;
    try {
      var list = vendetta.plugins && vendetta.plugins.plugins;
      var p = list && vendetta.plugin && list[vendetta.plugin.id];
      if (p && p.enabled === false) return false;
    } catch (e) {}
    return true;
  }

  function shutdown() {
    alive = false;
    cancelPending();
    undoList.forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
    undoList = [];
  }

  function installPatch() {
    var actions = metro.findByProps("sendMessage", "editMessage");
    if (!actions) throw new Error("sendMessage not found");
    undoList.push(
      patcher.instead("sendMessage", actions, function (args, original) {
        var self = this;
        var msg = args[1];
        var text = msg && msg.content;
        var needsFix = false;
        try {
          needsFix = isActive() && !!storage.enabled && typeof text === "string" && isConfigured() && !skipReason(text);
        } catch (e) {
          needsFix = false;
        }
        if (!needsFix && pending === 0) return original.apply(self, args);

        pending++;
        var task = queue.then(function () {
          var step;
          try {
            step = needsFix && isActive() ? correct(text) : Promise.resolve(text);
          } catch (e) {
            step = Promise.resolve(text);
          }
          return step
            .then(null, function () {
              return text;
            })
            .then(function (next) {
              if (next !== text) msg.content = next;
              return original.apply(self, args);
            });
        });
        var finish = function () {
          pending--;
        };
        queue = task.then(finish, finish);
        return task;
      })
    );
  }

  function warmUp() {
    try {
      if (!isConfigured()) return;
      fetch(String(storage.apiUrl).replace(/\/chat\/completions\/?$/, "/models"), {
        method: "GET",
        headers: { Authorization: "Bearer " + storage.apiKey },
      }).then(null, function () {});
    } catch (e) {}
  }

  function h() {
    return metro.common.React.createElement.apply(metro.common.React, arguments);
  }

  function RN() {
    return metro.common.ReactNative;
  }

  function colors() {
    var light = false;
    var store = null;
    var meta = null;
    var sc = vendetta.ui.semanticColors || {};
    try {
      store = metro.findByStoreName("ThemeStore");
      light = !!store && store.theme === "light";
    } catch (e) {}
    try {
      meta = metro.findByProps("colors", "meta").meta;
    } catch (e) {}
    function pick(colorName, dark, lightColor) {
      try {
        var c = meta.resolveSemanticColor(store.theme, sc[colorName]);
        if (typeof c === "string" && c) return c;
      } catch (e) {}
      return light ? lightColor : dark;
    }
    return {
      text: pick("TEXT_NORMAL", "#f2f3f5", "#060607"),
      muted: pick("TEXT_MUTED", "#b5bac1", "#5c5e66"),
      card: pick("BACKGROUND_SECONDARY", "#2b2d31", "#f2f3f5"),
      field: pick("BACKGROUND_TERTIARY", "#1e1f22", "#e3e5e8"),
      border: pick("BACKGROUND_MODIFIER_ACCENT", "#4e5058", "#c4c9ce"),
      accent: "#5865f2",
      danger: "#da373c",
      success: "#23a55a",
    };
  }

  function Card(props) {
    var c = colors();
    return h(
      RN().View,
      { style: { backgroundColor: c.card, borderRadius: 12, marginBottom: 12, padding: 14 } },
      props.title ? h(RN().Text, { style: { color: c.text, fontSize: 16, fontWeight: "700" } }, props.title) : null,
      props.children
    );
  }

  function Row(props) {
    var c = colors();
    return h(
      RN().View,
      { style: { marginTop: 12 } },
      h(
        RN().View,
        { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" } },
        h(
          RN().View,
          { style: { flex: 1, paddingRight: 12 } },
          h(RN().Text, { style: { color: c.text, fontSize: 15, fontWeight: "600" } }, props.name),
          props.note ? h(RN().Text, { style: { color: c.muted, fontSize: 12, marginTop: 2 } }, props.note) : null
        ),
        props.side || null
      ),
      props.body || null
    );
  }

  function Toggle(props) {
    var c = colors();
    var s = metro.common.React.useState(!!storage[props.field]);
    return h(RN().Switch, {
      testID: props.testID,
      value: s[0],
      trackColor: { true: c.accent },
      onValueChange: function (v) {
        storage[props.field] = v;
        s[1](v);
        if (props.onChange) props.onChange(v);
      },
    });
  }

  function Field(props) {
    var c = colors();
    return h(RN().TextInput, {
      testID: props.testID,
      defaultValue: props.value === undefined || props.value === null ? "" : String(props.value),
      onChangeText: props.onChange,
      placeholder: props.hint,
      placeholderTextColor: c.muted,
      secureTextEntry: !!props.secret,
      autoCapitalize: "none",
      autoCorrect: false,
      keyboardType: props.keyboard || "default",
      style: {
        marginTop: 8,
        backgroundColor: c.field,
        color: c.text,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
    });
  }

  function Button(props) {
    var c = colors();
    return h(
      RN().Pressable,
      {
        testID: props.testID,
        onPress: props.onPress,
        style: {
          backgroundColor: props.secondary ? c.field : c.accent,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 8,
          marginRight: 8,
          marginTop: 8,
          borderWidth: props.secondary ? 1 : 0,
          borderColor: c.border,
        },
      },
      h(RN().Text, { style: { color: props.secondary ? c.text : "#ffffff", fontWeight: "600" } }, props.label)
    );
  }

  function Panel() {
    var R = metro.common.React;
    var version = R.useState(0);
    var reveal = R.useState(false);
    var c = colors();
    function refresh() {
      version[1](function (n) {
        return n + 1;
      });
    }
    var labels = { apiUrl: "URL", apiKey: "API key", model: "model" };
    var absent = missing().map(function (k) {
      return labels[k];
    });
    var v = version[0];
    return h(
      RN().ScrollView,
      { keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 12, paddingBottom: 80 } },
      h(
        RN().View,
        { style: { marginBottom: 12, paddingHorizontal: 4 } },
        h(RN().Text, { style: { color: c.text, fontSize: 18, fontWeight: "700" } }, NAME),
        h(
          RN().Text,
          { style: { color: absent.length ? c.danger : c.success, fontSize: 13, marginTop: 4 } },
          absent.length ? "Missing: " + absent.join(", ") : "Ready"
        )
      ),
      h(
        Card,
        {},
        h(Row, {
          name: "Enabled",
          note: "Fix messages before they are sent.",
          side: h(Toggle, {
            field: "enabled",
            testID: "toggle-enabled",
            onChange: function (on) {
              if (!on) cancelPending();
            },
          }),
        })
      ),
      h(
        Card,
        { title: "AI API" },
        h(
          RN().View,
          { style: { flexDirection: "row", flexWrap: "wrap" } },
          h(Button, {
            testID: "btn-gemini",
            label: "Use Gemini",
            onPress: function () {
              storage.apiUrl = GEMINI_URL;
              storage.model = GEMINI_MODEL;
              refresh();
            },
          })
        ),
        h(Row, {
          name: "URL",
          body: h(Field, {
            key: "url" + v,
            testID: "in-url",
            value: storage.apiUrl,
            hint: "https://...",
            keyboard: "url",
            onChange: function (t) {
              storage.apiUrl = String(t).trim();
              refresh();
            },
          }),
        }),
        h(Row, {
          name: "Model",
          body: h(Field, {
            key: "model" + v,
            testID: "in-model",
            value: storage.model,
            hint: GEMINI_MODEL,
            onChange: function (t) {
              storage.model = String(t).trim();
              refresh();
            },
          }),
        }),
        h(Row, {
          name: "API key",
          body: h(
            RN().View,
            {},
            h(Field, {
              key: "apikey" + v + (reveal[0] ? "s" : "h"),
              testID: "in-key",
              value: storage.apiKey,
              hint: "paste your key",
              secret: !reveal[0],
              onChange: function (t) {
                storage.apiKey = String(t).trim();
                refresh();
              },
            }),
            h(
              RN().View,
              { style: { flexDirection: "row", flexWrap: "wrap" } },
              h(Button, {
                testID: "btn-paste",
                label: "Paste",
                onPress: function () {
                  try {
                    metro.common.clipboard.getString().then(function (t) {
                      t = String(t || "").trim();
                      if (!t) return toast("Clipboard is empty");
                      storage.apiKey = t;
                      refresh();
                    });
                  } catch (e) {
                    toast("Could not read the clipboard");
                  }
                },
              }),
              h(Button, {
                testID: "btn-reveal",
                secondary: true,
                label: reveal[0] ? "Hide" : "Show",
                onPress: function () {
                  reveal[1](!reveal[0]);
                },
              })
            )
          ),
        })
      )
    );
  }

  return {
    onLoad: function () {
      ["__corretor", "__grammify"].forEach(function (k) {
        try {
          var old = G[k];
          if (old && typeof old.desligar === "function") old.desligar();
          else if (old && typeof old.shutdown === "function") old.shutdown();
        } catch (e) {}
      });
      G.__grammify = { id: instanceId, shutdown: shutdown };
      alive = true;
      if (storage.apiUrl === undefined && storage.url) storage.apiUrl = storage.url;
      if (storage.apiKey === undefined && storage.chave) storage.apiKey = storage.chave;
      if (storage.model === undefined && storage.modelo) storage.model = storage.modelo;
      if (storage.enabled === undefined) storage.enabled = storage.ligada === undefined ? true : !!storage.ligada;
      try {
        installPatch();
      } catch (e) {
        alive = false;
        throw e;
      }
      warmUp();
    },
    onUnload: function () {
      shutdown();
      try {
        if (G.__grammify && G.__grammify.id === instanceId) G.__grammify = null;
      } catch (e) {}
    },
    settings: Panel,
  };
})();
