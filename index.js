(function () {
  "use strict";
  // ATENCAO: o primeiro caractere deste arquivo precisa ser "(" (sem comentario ou linha em branco antes).

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var storage = vendetta.plugin.storage;
  var showToast = vendetta.ui.toasts.showToast;

  var VERSAO = "0.8";
  var LIMITE_CARACTERES = 1500;
  var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  var GEMINI_MODELO = "gemini-3.5-flash-lite";

  // Trechos que a IA nunca ve nem mexe: codigo, mencoes (<@id>, <#id>, <@&id>), @everyone/@here, @nome,
  // #canal, emojis (do Discord e unicode), links (com ou sem http), e-mails, numeros/horas/datas.
  var PROTEGER = new RegExp(
    [
      "```[\\s\\S]*?```",
      "`[^`\\n]*`",
      "<[^>\\n]+>",
      "https?:\\/\\/\\S+",
      "(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|br|io|gg|me|app|dev|tv|co|ly|to|xyz|info|gov|edu|ai|us|uk|pt|de|fr|es|it|jp|ru|cc|ws|be|link|site|online)\\b(?:[\\/?#]\\S*)?",
      "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
      "@(?:everyone|here)\\b",
      "@[\\w.]+",
      "#[\\w-]+",
      ":[A-Za-z0-9_]+:",
      "\\d+(?:[.,:\\/-]\\d+)+",
      "[\\u2600-\\u27bf\\u2b00-\\u2bff\\ufe0f\\u200d]",
      "[\\ud83c-\\ud83e][\\udc00-\\udfff]",
    ].join("|"),
    "gi"
  );
  var MARCADOR = /\u00a7\d+\u00a7/g;
  var DE = "áàâãäåéèêëíìîïóòôõöúùûüçñ";
  var PARA = "aaaaaaeeeeiiiiooooouuuucn";

  var desfazer = []; // funcoes que desfazem os patches
  var fila = Promise.resolve();
  var pendentes = 0;
  var tempos = []; // duracao (s) das ultimas respostas da API
  var contagem = { ok: 0, recusadas: 0, falhas: 0 };
  var logs = []; // ultimos 100 registros (so na memoria; somem ao reiniciar o app)

  // ---------- logs ----------

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function hora() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function log(tipo, texto) {
    logs.push({ h: hora(), t: tipo, x: texto });
    if (logs.length > 100) logs.shift();
  }

  function linhaLog(e) {
    return e.h + " " + e.t + " " + e.x;
  }

  // ---------- utilidades ----------

  function avisar(texto) {
    try {
      showToast(texto);
    } catch (e) {}
  }

  function faltando() {
    return ["url", "chave", "modelo"].filter(function (k) {
      return !storage[k];
    });
  }

  function problemas() {
    var p = faltando().map(function (k) {
      return "falta " + k;
    });
    if (storage.url && String(storage.url).indexOf("https://") !== 0) p.push("a url precisa começar com https://");
    return p;
  }

  function limiteSeg() {
    return Number(storage.limite) || 6;
  }

  function estado() {
    var t = "Corretor v" + VERSAO + " · " + (storage.ligada ? "ligado" : "desligado");
    t += " · crase " + (storage.crase ? "ligada" : "desligada") + " · limite " + limiteSeg() + "s";
    return t;
  }

  function contar(re, s) {
    var m = s.match(re);
    return m ? m.length : 0;
  }

  // Texto "comparavel": sem acento, minusculo, sem . , ; : ~ e sem espacos repetidos.
  function chave(s) {
    return s
      .toLowerCase()
      .replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñ]/g, function (c) {
        return PARA.charAt(DE.indexOf(c));
      })
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[.,;:~]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  // Devolve o motivo para NAO corrigir (ou null se pode corrigir).
  function motivoPular(t) {
    if (!t.replace(/\s/g, "")) return "mensagem vazia";
    if (t.length > LIMITE_CARACTERES) return "mensagem muito longa";
    if (/^(s\/|\+:|\/)/.test(t)) return "comando do app (começa com s/, +: ou /)";
    return null;
  }

  function montarPrompt() {
    return [
      "Você é um revisor de mensagens de chat em português. A mensagem foi digitada de qualquer jeito (sem acentos, sem pontuação, sem maiúsculas). Devolva a MESMA mensagem corrigida, fazendo um trabalho COMPLETO nestes três itens, sem deixar nada para trás:",
      "1) ACENTOS: coloque todos os acentos e cedilhas que as palavras exigem (você, não, amanhã, já, é, está, tá, né, pão, vídeo...). Leia a frase inteira para decidir entre palavras parecidas (e/é, esta/está, ja/já).",
      "2) MAIÚSCULAS: a primeira letra de cada frase e os nomes próprios (pessoas, lugares, marcas).",
      "3) PONTUAÇÃO: ponto final no fim de toda frase afirmativa; vírgulas onde a gramática pede (vocativos, listas, orações, expressões como então, porém, né). Você também pode usar dois-pontos (:), ponto e vírgula (;) e til (~) quando fizerem sentido. Só deixe sem ponto final se a frase for CLARAMENTE uma pergunta (nesse caso, sem ponto final e sem interrogação).",
      "PROIBIDO: trocar, remover, adicionar, juntar, separar ou reordenar palavras; corrigir gírias, abreviações (vc, tb, blz, kkk) ou erros de digitação; mudar o tom; adicionar emojis, exclamações ou interrogações; mexer em porque/por que/porquê, mas/mais, a/há.",
      storage.crase ? "Use crase (à, às, àquele) quando a gramática exigir." : "NÃO use crase.",
      "Se o texto não estiver em português, devolva-o exatamente igual.",
      "Mantenha as quebras de linha e os marcadores \u00a7número\u00a7 exatamente onde estão.",
      "EXEMPLOS (entrada => saída):",
      "oi tudo bem com voce => Oi, tudo bem com você",
      "nao sei se vou amanha => Não sei se vou amanhã.",
      "ta bom entao fechado => Tá bom, então fechado.",
      "comprei pao leite e ovos no mercado => Comprei pão, leite e ovos no mercado.",
      "vc ja viu o video que o joao mandou => Vc já viu o vídeo que o João mandou",
      "mano que loucura isso ne => Mano, que loucura isso, né.",
      "eu vou sair mais cedo hoje porque tenho consulta => Eu vou sair mais cedo hoje porque tenho consulta.",
      "valeu => Valeu.",
      "kkkk => kkkk",
      "Responda somente com o texto final, sem aspas e sem comentários.",
    ].join("\n");
  }

  // Resumo curto de um texto de erro da API, sem a chave.
  function trecho(t) {
    t = String(t || "").replace(/\s+/g, " ");
    if (storage.chave) t = t.split(String(storage.chave)).join("***");
    return t.length > 160 ? t.slice(0, 160) + "…" : t;
  }

  // ---------- chamada da API (com tempo limite) ----------

  function chamarApi(texto, limiteOpcional) {
    if (faltando().length) return Promise.reject(new Error("falta configurar: " + faltando().join(", ")));
    if (String(storage.url).indexOf("https://") !== 0) {
      return Promise.reject(new Error("url precisa começar com https://"));
    }
    var limiteMs = limiteOpcional || limiteSeg() * 1000;
    var controlador = typeof AbortController === "function" ? new AbortController() : null;
    var timer;

    var pedido = fetch(storage.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + storage.chave,
      },
      body: JSON.stringify({
        model: storage.modelo,
        messages: [
          { role: "system", content: montarPrompt() },
          { role: "user", content: texto },
        ],
      }),
      signal: controlador ? controlador.signal : undefined,
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(
            function (corpo) {
              throw new Error("HTTP " + r.status + ": " + trecho(corpo));
            },
            function () {
              throw new Error("HTTP " + r.status);
            }
          );
        }
        return r.json();
      })
      .then(function (d) {
        return d.choices[0].message.content;
      });

    var prazo = new Promise(function (_, rejeitar) {
      timer = setTimeout(function () {
        if (controlador) controlador.abort();
        rejeitar(new Error("tempo limite"));
      }, limiteMs);
    });

    return Promise.race([pedido, prazo]).then(
      function (v) {
        clearTimeout(timer);
        return v;
      },
      function (e) {
        clearTimeout(timer);
        throw e;
      }
    );
  }

  // ---------- validacao: a IA so pode mexer em acento, maiuscula e nos sinais . , ; : ~ ----------

  function validar(entrada, saida, nMarcadores) {
    if (typeof saida !== "string" || !saida) return "resposta vazia";
    saida = saida.replace(/^\s+|\s+$/g, "");
    if (chave(saida) !== chave(entrada)) return "IA alterou palavras ou símbolos";
    if (contar(/\n/g, saida) !== contar(/\n/g, entrada)) return "IA mudou as quebras de linha";
    if (saida.length > entrada.length * 1.5 + 10) return "resposta grande demais";
    for (var i = 0; i < nMarcadores; i++) {
      if (contar(new RegExp("\u00a7" + i + "\u00a7", "g"), saida) !== 1) {
        return "IA perdeu um trecho protegido";
      }
    }
    if (!storage.crase && contar(/[àÀ]/g, saida) > contar(/[àÀ]/g, entrada)) return "IA usou crase";
    if (contar(/porqu[êÊ]/gi, saida) > contar(/porqu[êÊ]/gi, entrada)) return "IA mexeu em porquê";
    return null;
  }

  // Processa um texto. Nunca rejeita: devolve { final, veredito, bruto, seg }.
  function processar(texto, limiteOpcional) {
    var guardados = [];
    var protegido = texto.replace(PROTEGER, function (m) {
      guardados.push(m);
      return "\u00a7" + (guardados.length - 1) + "\u00a7";
    });
    if (!/[A-Za-z\u00c0-\u00ff]/.test(protegido.replace(MARCADOR, ""))) {
      return Promise.resolve({ final: texto, veredito: "ignorada: sem letras", bruto: "", seg: 0 });
    }
    var inicio = Date.now();
    return chamarApi(protegido, limiteOpcional).then(
      function (resposta) {
        var seg = (Date.now() - inicio) / 1000;
        var bruto = typeof resposta === "string" ? resposta : "";
        if (typeof resposta === "string") {
          // Crase desligada: tira a crase que a IA colocou, mas aproveita o resto da correcao.
          if (!storage.crase && contar(/[àÀ]/g, resposta) > contar(/[àÀ]/g, protegido)) {
            resposta = resposta.replace(/à/g, "a").replace(/À/g, "A");
          }
          // Nao mexe em porque/porquê: desfaz o acento que a IA colocou.
          if (contar(/porqu[êÊ]/gi, resposta) > contar(/porqu[êÊ]/gi, protegido)) {
            resposta = resposta.replace(/porquê/g, "porque").replace(/Porquê/g, "Porque").replace(/PORQUÊ/g, "PORQUE");
          }
        }
        var motivo = validar(protegido, resposta, guardados.length);
        if (motivo) return { final: texto, veredito: "recusada: " + motivo, bruto: bruto, seg: seg };
        var corrigido = resposta.replace(/^\s+|\s+$/g, "");
        guardados.forEach(function (original, i) {
          corrigido = corrigido.split("\u00a7" + i + "\u00a7").join(original);
        });
        return { final: corrigido, veredito: "ok", bruto: bruto, seg: seg };
      },
      function (erro) {
        return {
          final: texto,
          veredito: "falha: " + String((erro && erro.message) || erro),
          bruto: "",
          seg: (Date.now() - inicio) / 1000,
        };
      }
    );
  }

  function guardarTempo(seg) {
    tempos.push(seg);
    if (tempos.length > 50) tempos.shift();
  }

  // Conta nas estatisticas e grava no log.
  function registrarResultado(origem, texto, r) {
    var tipo = "INFO";
    if (r.veredito === "ok") {
      contagem.ok++;
      tipo = "OK";
    } else if (r.veredito.indexOf("recusada") === 0) {
      contagem.recusadas++;
      tipo = "RECUSADA";
    } else if (r.veredito.indexOf("falha") === 0) {
      contagem.falhas++;
      tipo = "FALHA";
    }
    if (tipo === "OK" || tipo === "RECUSADA") guardarTempo(r.seg);
    var cab = "[" + origem + "] " + r.veredito + " (" + r.seg.toFixed(1) + "s)";
    if (storage.logTexto === false) {
      log(tipo, cab + " " + texto.length + " caracteres");
    } else {
      log(tipo, cab + "\n    Você: " + texto + "\n    IA:   " + (r.bruto || "(sem resposta)"));
    }
  }

  function resumo() {
    var t = "ok " + contagem.ok + ", recusadas " + contagem.recusadas + ", falhas " + contagem.falhas;
    if (tempos.length) {
      var soma = 0,
        max = 0;
      tempos.forEach(function (x) {
        soma += x;
        if (x > max) max = x;
      });
      t = "média " + (soma / tempos.length).toFixed(1) + "s, máx " + max.toFixed(1) + "s | " + t;
    }
    return t;
  }

  // Texto completo para copiar e colar no chat com o Claude. Nunca inclui a chave nem a url da API.
  function relatorio() {
    var linhas = [
      estado() + " · modelo " + (storage.modelo || "?") + " · texto nos logs " + (storage.logTexto === false ? "não" : "sim"),
      resumo(),
      "---",
    ];
    logs.forEach(function (e) {
      linhas.push(linhaLog(e));
    });
    return linhas.join("\n");
  }

  function copiar(texto, msgOk) {
    try {
      metro.common.clipboard.setString(texto);
      avisar(msgOk);
    } catch (e) {
      avisar("Não consegui copiar. Segure o texto dos logs para selecionar.");
    }
  }

  // ---------- diagnostico de velocidade (conexao x modelo) ----------

  // Faz um pedido e nunca rejeita: devolve { status, corpo, seg, erro }.
  function pedirSimples(url, opcoes, limiteMs) {
    var inicio = Date.now();
    var controlador = typeof AbortController === "function" ? new AbortController() : null;
    var timer;
    var pedido = fetch(url, Object.assign({}, opcoes, { signal: controlador ? controlador.signal : undefined })).then(function (r) {
      return r.text().then(function (corpo) {
        return { status: r.status, corpo: corpo };
      });
    });
    var prazo = new Promise(function (_, rejeitar) {
      timer = setTimeout(function () {
        if (controlador) controlador.abort();
        rejeitar(new Error("tempo limite de " + limiteMs / 1000 + "s"));
      }, limiteMs);
    });
    return Promise.race([pedido, prazo]).then(
      function (r) {
        clearTimeout(timer);
        r.seg = (Date.now() - inicio) / 1000;
        return r;
      },
      function (e) {
        clearTimeout(timer);
        return { status: 0, erro: String((e && e.message) || e), corpo: "", seg: (Date.now() - inicio) / 1000 };
      }
    );
  }

  function cabecalhosApi() {
    return { "Content-Type": "application/json", Authorization: "Bearer " + storage.chave };
  }

  function descreverDiag(nome, r, mostrarResposta) {
    var linha = nome + ": " + (r.erro ? "FALHA (" + r.erro + ")" : "HTTP " + r.status) + " em " + r.seg.toFixed(1) + "s";
    if (!r.erro && (r.status < 200 || r.status >= 300)) {
      linha += " — " + trecho(r.corpo);
    } else if (!r.erro && mostrarResposta) {
      try {
        linha += " — resposta: " + trecho(JSON.parse(r.corpo).choices[0].message.content);
      } catch (e) {
        linha += " — resposta em formato inesperado";
      }
    }
    log("DIAG", linha);
    return linha;
  }

  // 1) So a conexao: pede a lista de modelos (sem gerar texto).
  function diagConexao() {
    var base = String(storage.url).replace(/\/chat\/completions\/?$/, "/models");
    return pedirSimples(base, { method: "GET", headers: cabecalhosApi() }, 30000).then(function (r) {
      return descreverDiag("Conexão (lista de modelos)", r, false);
    });
  }

  // 2) Uma chamada minima ao modelo, sem o nosso prompt grande.
  function diagMinima() {
    var corpo = JSON.stringify({ model: storage.modelo, messages: [{ role: "user", content: "Responda apenas: ok" }] });
    return pedirSimples(storage.url, { method: "POST", headers: cabecalhosApi(), body: corpo }, 30000).then(function (r) {
      return descreverDiag("Chamada mínima", r, true);
    });
  }

  // ---------- ligacao com o Discord ----------

  function instalarPatch() {
    var Acoes = metro.findByProps("sendMessage", "editMessage");
    if (!Acoes) throw new Error("não achei sendMessage no Discord");
    desfazer.push(
      patcher.instead("sendMessage", Acoes, function (args, original) {
        var self = this;
        var msg = args[1];
        var texto = msg && msg.content;
        var precisa = false;
        if (storage.ligada && typeof texto === "string" && texto.replace(/\s/g, "")) {
          var pular = faltando().length ? "falta configurar: " + faltando().join(", ") : motivoPular(texto);
          if (pular) log("INFO", "[envio] ignorada: " + pular);
          else precisa = true;
        }
        // Mantem a ordem das mensagens: se ha algo na fila, tudo entra na fila.
        if (!precisa && pendentes === 0) return original.apply(self, args);

        pendentes++;
        var tarefa = fila.then(function () {
          var passo = precisa
            ? processar(texto).then(function (r) {
                registrarResultado("envio", texto, r);
                return r.final;
              })
            : Promise.resolve(texto);
          return passo.then(function (novo) {
            if (novo !== texto) msg.content = novo;
            return original.apply(self, args);
          });
        });
        var fim = function () {
          pendentes--;
        };
        fila = tarefa.then(fim, fim);
        return tarefa;
      })
    );
  }

  // ====================== PAINEL DE CONFIGURACAO ======================
  // Estrutura igual a do BetterDiscord: painel > grupos recolhiveis > itens (nome, nota, controle).
  // Tudo e criado so quando o painel abre; se algo aqui falhar, a correcao de mensagens continua funcionando.

  function h() {
    return metro.common.React.createElement.apply(metro.common.React, arguments);
  }

  function RN() {
    return metro.common.ReactNative;
  }

  function useTick(ms) {
    var s = metro.common.React.useState(0);
    metro.common.React.useEffect(function () {
      var id = setInterval(function () {
        s[1](function (n) {
          return n + 1;
        });
      }, ms);
      return function () {
        clearInterval(id);
      };
    }, []);
    return s[0];
  }

  function cores() {
    var claro = false,
      store = null,
      meta = null,
      sc = vendetta.ui.semanticColors || {};
    try {
      store = metro.findByStoreName("ThemeStore");
      claro = !!store && store.theme === "light";
    } catch (e) {}
    try {
      meta = metro.findByProps("colors", "meta").meta;
    } catch (e) {}
    function r(nomeCor, escuro, claroCor) {
      try {
        var c = meta.resolveSemanticColor(store.theme, sc[nomeCor]);
        if (typeof c === "string" && c) return c;
      } catch (e) {}
      return claro ? claroCor : escuro;
    }
    return {
      texto: r("TEXT_NORMAL", "#f2f3f5", "#060607"),
      mudo: r("TEXT_MUTED", "#b5bac1", "#5c5e66"),
      cartao: r("BACKGROUND_SECONDARY", "#2b2d31", "#f2f3f5"),
      campo: r("BACKGROUND_TERTIARY", "#1e1f22", "#e3e5e8"),
      borda: r("BACKGROUND_MODIFIER_ACCENT", "#4e5058", "#c4c9ce"),
      destaque: "#5865f2",
      perigo: "#da373c",
      sucesso: "#23a55a",
    };
  }

  function Grupo(props) {
    var c = cores();
    var s = metro.common.React.useState(props.aberto !== false);
    var aberto = s[0];
    return h(
      RN().View,
      { style: { backgroundColor: c.cartao, borderRadius: 12, marginBottom: 12, overflow: "hidden" } },
      h(
        RN().Pressable,
        {
          testID: "grupo-" + props.id,
          onPress: function () {
            s[1](!aberto);
          },
          style: { padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
        },
        h(RN().Text, { style: { color: c.texto, fontSize: 16, fontWeight: "700" } }, props.titulo),
        h(RN().Text, { style: { color: c.mudo, fontSize: 16 } }, aberto ? "▾" : "▸")
      ),
      aberto ? h(RN().View, { style: { paddingHorizontal: 14, paddingBottom: 14 } }, props.children) : null
    );
  }

  function Item(props) {
    var c = cores();
    return h(
      RN().View,
      { style: { marginTop: 12 } },
      h(
        RN().View,
        { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" } },
        h(
          RN().View,
          { style: { flex: 1, paddingRight: 12 } },
          h(RN().Text, { style: { color: c.texto, fontSize: 15, fontWeight: "600" } }, props.nome),
          props.nota ? h(RN().Text, { style: { color: c.mudo, fontSize: 12, marginTop: 2 } }, props.nota) : null
        ),
        props.lado || null
      ),
      props.corpo || null
    );
  }

  function Interruptor(props) {
    var c = cores();
    var s = metro.common.React.useState(!!storage[props.campo]);
    return h(RN().Switch, {
      testID: props.testID,
      value: s[0],
      trackColor: { true: c.destaque },
      onValueChange: function (v) {
        storage[props.campo] = v;
        s[1](v);
        log("INFO", "configuração: " + props.campo + " = " + v);
      },
    });
  }

  function Campo(props) {
    var c = cores();
    return h(RN().TextInput, {
      testID: props.testID,
      defaultValue: props.valor === undefined || props.valor === null ? "" : String(props.valor),
      onChangeText: props.aoMudar,
      placeholder: props.dica,
      placeholderTextColor: c.mudo,
      secureTextEntry: !!props.segredo,
      autoCapitalize: "none",
      autoCorrect: false,
      keyboardType: props.teclado || "default",
      style: {
        marginTop: 8,
        backgroundColor: c.campo,
        color: c.texto,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.borda,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
    });
  }

  function Botao(props) {
    var c = cores();
    var fundo = props.perigo ? c.perigo : props.secundario ? c.campo : c.destaque;
    return h(
      RN().Pressable,
      {
        testID: props.testID,
        onPress: props.aoTocar,
        style: {
          backgroundColor: fundo,
          paddingVertical: 10,
          paddingHorizontal: 14,
          borderRadius: 8,
          marginRight: 8,
          marginTop: 8,
          borderWidth: props.secundario ? 1 : 0,
          borderColor: c.borda,
        },
      },
      h(RN().Text, { style: { color: props.secundario ? c.texto : "#ffffff", fontWeight: "600" } }, props.texto)
    );
  }

  function Linha(props) {
    return h(RN().View, { style: { flexDirection: "row", flexWrap: "wrap" } }, props.children);
  }

  function Texto(props) {
    var c = cores();
    return h(
      RN().Text,
      {
        selectable: true,
        style: {
          color: props.mudo ? c.mudo : c.texto,
          fontSize: props.pequeno ? 12 : 14,
          marginTop: 8,
          fontFamily: props.mono ? "monospace" : undefined,
        },
      },
      props.children
    );
  }

  function Cabecalho() {
    useTick(1500);
    var c = cores();
    var p = problemas();
    return h(
      RN().View,
      { style: { marginBottom: 12, paddingHorizontal: 4 } },
      h(RN().Text, { style: { color: c.texto, fontSize: 18, fontWeight: "700" } }, "Corretor"),
      h(RN().Text, { style: { color: c.mudo, fontSize: 13, marginTop: 2 } }, estado()),
      p.length
        ? h(RN().Text, { style: { color: c.perigo, fontSize: 13, marginTop: 4 } }, "Atenção: " + p.join(", ") + ".")
        : h(RN().Text, { style: { color: c.sucesso, fontSize: 13, marginTop: 4 } }, "Configuração completa.")
    );
  }

  function GrupoApi() {
    var R = metro.common.React;
    var v = R.useState(0); // muda para recriar os campos depois de preencher por botao
    var mostrar = R.useState(false);
    function recarregar() {
      v[1](v[0] + 1);
    }
    return h(
      Grupo,
      { id: "api", titulo: "API de IA" },
      h(Item, {
        nome: "Atalho: Gemini 3.5 Flash-Lite",
        nota: "Preenche a url e o modelo. Depois é só colar a chave.",
        corpo: h(
          Linha,
          {},
          h(Botao, {
            testID: "btn-gemini",
            texto: "Preencher Gemini",
            aoTocar: function () {
              storage.url = GEMINI_URL;
              storage.modelo = GEMINI_MODELO;
              log("INFO", "configuração: url e modelo preenchidos com o atalho do Gemini");
              recarregar();
            },
          })
        ),
      }),
      h(Item, {
        nome: "Endereço da API (url)",
        nota: "Precisa começar com https://. Formato compatível com a API da OpenAI.",
        corpo: h(Campo, {
          key: "url" + v[0],
          testID: "in-url",
          valor: storage.url,
          dica: "https://...",
          teclado: "url",
          aoMudar: function (t) {
            storage.url = String(t).trim();
          },
        }),
      }),
      h(Item, {
        nome: "Modelo",
        corpo: h(Campo, {
          key: "modelo" + v[0],
          testID: "in-modelo",
          valor: storage.modelo,
          dica: "gemini-3.5-flash-lite",
          aoMudar: function (t) {
            storage.modelo = String(t).trim();
          },
        }),
      }),
      h(Item, {
        nome: "Chave da API",
        nota: "Fica guardada só neste aparelho, sem criptografia.",
        corpo: h(
          RN().View,
          {},
          h(Campo, {
            key: "chave" + v[0] + (mostrar[0] ? "m" : "o"),
            testID: "in-chave",
            valor: storage.chave,
            dica: "cole a chave aqui",
            segredo: !mostrar[0],
            aoMudar: function (t) {
              storage.chave = String(t).trim();
            },
          }),
          h(
            Linha,
            {},
            h(Botao, {
              testID: "btn-colar",
              texto: "Colar chave",
              aoTocar: function () {
                try {
                  metro.common.clipboard.getString().then(function (t) {
                    t = String(t || "").trim();
                    if (!t) return avisar("A área de transferência está vazia");
                    storage.chave = t;
                    log("INFO", "configuração: chave colada da área de transferência");
                    avisar("Chave colada");
                    recarregar();
                  });
                } catch (e) {
                  avisar("Não consegui ler a área de transferência");
                }
              },
            }),
            h(Botao, {
              testID: "btn-mostrar",
              secundario: true,
              texto: mostrar[0] ? "Ocultar" : "Mostrar",
              aoTocar: function () {
                mostrar[1](!mostrar[0]);
              },
            })
          )
        ),
      }),
      h(Item, {
        nome: "Tempo limite (segundos)",
        nota: "De 1 a 30. Se a IA demorar mais que isso, a mensagem sai sem correção.",
        corpo: h(Campo, {
          testID: "in-limite",
          valor: storage.limite,
          dica: "6",
          teclado: "numeric",
          aoMudar: function (t) {
            var n = Number(String(t).replace(",", "."));
            if (n >= 1 && n <= 30) storage.limite = n;
          },
        }),
      })
    );
  }

  function GrupoTeste() {
    var R = metro.common.React;
    var texto = R.useRef("fui a escola ontem e comprei pao leite e ovos");
    var res = R.useState(null);
    var ocupado = R.useState(false);
    function rodar(limiteMs) {
      if (ocupado[0]) return;
      var p = problemas();
      if (p.length) {
        res[1]({ aviso: "Antes de testar: " + p.join(", ") + "." });
        return;
      }
      var entrada = texto.current;
      ocupado[1](true);
      res[1](null);
      processar(entrada, limiteMs).then(function (r) {
        registrarResultado("teste", entrada, r);
        res[1](r);
        ocupado[1](false);
      });
    }
    var r = res[0];
    return h(
      Grupo,
      { id: "teste", titulo: "Testar sem enviar mensagem" },
      h(Item, {
        nome: "Texto de teste",
        nota: "Roda a correção aqui dentro. Nada é enviado ao Discord.",
        corpo: h(Campo, {
          testID: "in-teste",
          valor: texto.current,
          dica: "digite um texto",
          aoMudar: function (t) {
            texto.current = t;
          },
        }),
      }),
      h(
        Linha,
        {},
        h(Botao, {
          testID: "btn-testar",
          texto: ocupado[0] ? "Testando..." : "Testar correção",
          aoTocar: function () {
            rodar(undefined);
          },
        }),
        h(Botao, {
          testID: "btn-testar-30",
          secundario: true,
          texto: "Testar com limite de 30 s",
          aoTocar: function () {
            rodar(30000);
          },
        })
      ),
      r && r.aviso ? h(Texto, { mudo: true }, r.aviso) : null,
      r && !r.aviso
        ? h(
            RN().View,
            {},
            h(Texto, {}, "Resultado: " + r.final),
            h(Texto, { mudo: true, pequeno: true }, "Veredito: " + r.veredito + " (" + r.seg.toFixed(1) + "s)"),
            h(Texto, { mudo: true, pequeno: true }, "Resposta bruta da IA: " + (r.bruto || "(sem resposta)"))
          )
        : null
    );
  }

  function GrupoDiagnostico() {
    var R = metro.common.React;
    var linhas = R.useState([]);
    var ocupado = R.useState(false);
    function rodar(funcao) {
      if (ocupado[0]) return;
      var p = problemas();
      if (p.length) {
        linhas[1](linhas[0].concat(["Antes de testar: " + p.join(", ") + "."]));
        return;
      }
      ocupado[1](true);
      funcao().then(function (linha) {
        linhas[1](function (antes) {
          return antes.concat([linha]);
        });
        ocupado[1](false);
      });
    }
    return h(
      Grupo,
      { id: "diag", titulo: "Diagnóstico de velocidade", aberto: false },
      h(
        Texto,
        { mudo: true, pequeno: true },
        "Se a conexão for rápida e a chamada mínima for lenta, o lento é o modelo do provedor. Se as duas forem lentas, é a rede. Cada teste espera até 30 s."
      ),
      h(
        Linha,
        {},
        h(Botao, { testID: "btn-diag-conexao", texto: ocupado[0] ? "Aguarde..." : "Testar conexão", aoTocar: function () { rodar(diagConexao); } }),
        h(Botao, { testID: "btn-diag-minima", secundario: true, texto: "Chamada mínima", aoTocar: function () { rodar(diagMinima); } }),
        h(Botao, { testID: "btn-diag-limpar", secundario: true, texto: "Limpar", aoTocar: function () { linhas[1]([]); } })
      ),
      h(Texto, { mono: true, pequeno: true }, linhas[0].length ? linhas[0].join("\n") : "(nenhum teste ainda)")
    );
  }

  function GrupoEstatisticas() {
    useTick(1000);
    var R = metro.common.React;
    var forcar = R.useState(0);
    return h(
      Grupo,
      { id: "stats", titulo: "Estatísticas" },
      h(Texto, {}, resumo()),
      h(Texto, { mudo: true, pequeno: true }, "Falhas incluem tempo esgotado, erro de rede e erro da API."),
      h(
        Linha,
        {},
        h(Botao, {
          testID: "btn-zerar",
          secundario: true,
          texto: "Zerar estatísticas",
          aoTocar: function () {
            tempos = [];
            contagem = { ok: 0, recusadas: 0, falhas: 0 };
            log("INFO", "estatísticas zeradas");
            forcar[1](forcar[0] + 1);
          },
        })
      )
    );
  }

  function GrupoLogs() {
    useTick(1000);
    var R = metro.common.React;
    var forcar = R.useState(0);
    var ultimos = logs.slice(-15);
    return h(
      Grupo,
      { id: "logs", titulo: "Logs" },
      h(Item, {
        nome: "Guardar o texto das mensagens nos logs",
        nota: "Desligado, o log mostra só o tamanho do texto. Os logs ficam na memória e somem ao reiniciar o app.",
        lado: h(Interruptor, { campo: "logTexto", testID: "sw-logtexto" }),
      }),
      h(
        Linha,
        {},
        h(Botao, {
          testID: "btn-copiar-logs",
          texto: "Copiar logs",
          aoTocar: function () {
            copiar(relatorio(), "Logs copiados (" + logs.length + " registros)");
          },
        }),
        h(Botao, {
          testID: "btn-limpar-logs",
          secundario: true,
          texto: "Limpar logs",
          aoTocar: function () {
            logs = [];
            forcar[1](forcar[0] + 1);
            avisar("Logs limpos");
          },
        })
      ),
      h(
        Texto,
        { mudo: true, pequeno: true },
        "Mostrando os últimos " + ultimos.length + " de " + logs.length + ". O botão copia todos. Você também pode segurar o texto abaixo para selecionar."
      ),
      h(
        Texto,
        { mono: true, pequeno: true },
        ultimos.length ? ultimos.map(linhaLog).join("\n") : "(nenhum registro ainda)"
      )
    );
  }

  function Painel() {
    return h(
      RN().ScrollView,
      { keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 12, paddingBottom: 80 } },
      h(Cabecalho, {}),
      h(
        Grupo,
        { id: "geral", titulo: "Geral" },
        h(Item, {
          nome: "Correção ligada",
          nota: "Corrige acentos, maiúsculas e pontuação antes de enviar. Desligado, as mensagens saem como digitadas.",
          lado: h(Interruptor, { campo: "ligada", testID: "sw-ligada" }),
        }),
        h(Item, {
          nome: "Permitir crase",
          nota: "A IA pode usar crase (à, às). Desligado, ela nunca usa.",
          lado: h(Interruptor, { campo: "crase", testID: "sw-crase" }),
        })
      ),
      h(GrupoApi, {}),
      h(GrupoTeste, {}),
      h(GrupoDiagnostico, {}),
      h(GrupoEstatisticas, {}),
      h(GrupoLogs, {})
    );
  }

  return {
    onLoad: function () {
      if (storage.ligada === undefined) storage.ligada = true;
      if (storage.crase === undefined) storage.crase = false;
      if (storage.limite === undefined) storage.limite = 6;
      if (storage.logTexto === undefined) storage.logTexto = true;
      log("INFO", "plugin carregado (v" + VERSAO + ")");
      try {
        instalarPatch(); // se falhar, o plugin se desliga e avisa
        log("INFO", "patch de envio instalado");
      } catch (e) {
        log("ERRO", "não consegui instalar o patch de envio: " + (e && e.message));
        throw e;
      }
    },
    onUnload: function () {
      desfazer.forEach(function (f) {
        try {
          f();
        } catch (e) {}
      });
      desfazer = [];
    },
    settings: Painel,
  };
})()
