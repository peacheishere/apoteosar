(function () {
  "use strict";

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var storage = vendetta.plugin.storage;
  var showToast = vendetta.ui.toasts.showToast;

  var NOME = "Grammify";
  var LIMITE_CARACTERES = 1500;
  var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  var GEMINI_MODELO = "gemini-3.5-flash-lite";

  var PROTEGER = new RegExp(
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
  var MARCADOR = /\u00a7\d+\u00a7/g;
  var PALAVRA = new RegExp("[^\\s!-\\/:-@\\[-`{-~]+", "g");
  var CHAR_ENTRE = /[\s.,;:~]/;
  var COM_ACENTO = "áàâãäåéèêëíìîïóòôõöúùûüçñ";
  var SEM_ACENTO = "aaaaaaeeeeiiiiooooouuuucn";

  var PROMPT = [
    "Você revisa mensagens de chat em português do Brasil. O texto foi digitado sem acentos, sem pontuação e sem maiúsculas. Devolva a MESMA mensagem corrigida, mudando SOMENTE estas três coisas:",
    "1) ACENTOS, cedilha e crase (à, às, àquele), conforme a gramática do português brasileiro. Leia a frase inteira para escolher entre e/é, esta/está, ja/já, a/à. Palavras em MAIÚSCULAS também recebem acento (VOCÊ).",
    "2) MAIÚSCULAS: apenas a primeira letra da mensagem, a primeira letra depois de ponto final, ? ou ! e os nomes próprios (pessoas, lugares, marcas). Depois de vírgula, ponto e vírgula ou dois-pontos a palavra continua minúscula (salvo nome próprio).",
    "3) PONTUAÇÃO: use ponto final, vírgula, ponto e vírgula (;) e dois-pontos (:) como manda a gramática do português brasileiro; til (~) só quando fizer sentido. O ponto final pode ir no MEIO do texto, separando frases (a próxima começa com maiúscula), e também no fim. Se já houver pontuação errada ou sobrando, REMOVA, TROQUE ou MUDE DE LUGAR. Só deixe sem ponto final se a frase for CLARAMENTE uma pergunta (sem ponto final e sem interrogação).",
    "CAIXA ALTA: palavras ou trechos que já estão em MAIÚSCULAS (caps lock) ficam em maiúsculas, nunca passe para minúsculas. Se a mensagem inteira está em maiúsculas, devolva-a inteira em maiúsculas (só acentos e pontuação mudam). Nunca ponha em maiúsculas uma palavra que estava minúscula, exceto a letra inicial quando a regra 2 pedir.",
    "OUTRO IDIOMA: se a frase é em português mas tem uma ou mais palavras em inglês (ou outro idioma), mesmo no meio ou no fim, trate a frase como português: corrija o resto normalmente e coloque a pontuação, inclusive o ponto final. Deixe as palavras estrangeiras exatamente como estão (não traduza, não acentue, não mude a caixa). Só devolva o texto igual se a mensagem INTEIRA não estiver em português.",
    "PROIBIDO: trocar, remover, adicionar, juntar, separar ou reordenar palavras; corrigir gírias, abreviações (vc, tb, blz, kkk) ou erros de digitação; mudar o tom; adicionar emojis, exclamações, interrogações ou qualquer símbolo que não seja . , ; : ~ ; mexer em porque/por que/porquê, mas/mais, a/há. Interrogações e exclamações que já estão no texto ficam exatamente onde estão.",
    "Mantenha as quebras de linha e os marcadores \u00a7número\u00a7 exatamente onde estão. Responda somente com o texto final, sem aspas e sem comentários.",
    "EXEMPLOS (entrada => saída):",
    "oi tudo bem com voce => Oi, tudo bem com você",
    "nao sei se vou amanha => Não sei se vou amanhã.",
    "comprei pao leite e ovos no mercado => Comprei pão, leite e ovos no mercado.",
    "cheguei em casa agora vou tomar banho depois a gente conversa => Cheguei em casa agora. Vou tomar banho, depois a gente conversa.",
    "eu, fui ao mercado. e comprei pao => Eu fui ao mercado e comprei pão.",
    "fui a escola hoje => Fui à escola hoje.",
    "eu amei esse filme foi muito good => Eu amei esse filme, foi muito good.",
    "vou comprar um mouse novo na loja hoje => Vou comprar um mouse novo na loja hoje.",
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
  var idInstancia = String(Date.now()) + "-" + String(Math.random()).slice(2);
  var vivo = false;
  var desfazer = [];
  var fila = Promise.resolve();
  var pendentes = 0;
  var emVoo = [];
  var bloqueadoAte = 0;
  var ultimoAviso = 0;
  var cache = {};
  var chavesCache = [];

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

  function configurado() {
    return faltando().length === 0 && String(storage.url).indexOf("https://") === 0;
  }

  function contar(re, s) {
    var m = s.match(re);
    return m ? m.length : 0;
  }

  function tirarAcentos(s) {
    try {
      if (s.normalize) s = s.normalize("NFD");
    } catch (e) {}
    return s.replace(/[\u0300-\u036f]/g, "").replace(/[áàâãäåéèêëíìîïóòôõöúùûüçñ]/g, function (c) {
      return SEM_ACENTO.charAt(COM_ACENTO.indexOf(c));
    });
  }

  function chavePalavra(s) {
    return tirarAcentos(s.toLowerCase());
  }

  function motivoPular(texto) {
    if (!texto.replace(/\s/g, "")) return "vazia";
    if (texto.length > LIMITE_CARACTERES) return "muito longa";
    if (/^(s\/|\+:|\/)/.test(texto)) return "comando do app";
    if (/^\s*(?:k{2,}|(?:ha){2,}h?|(?:he){2,}h?|(?:rs)+)\s*$/i.test(texto)) return "risada";
    if (Date.now() < bloqueadoAte) return "limite da API";
    return null;
  }

  function cancelarPendentes() {
    var lista = emVoo.slice();
    lista.forEach(function (item) {
      try {
        item.cancelar();
      } catch (e) {}
    });
    return lista.length;
  }

  function marcarLimite(erro) {
    var s = Number(erro && erro.espera);
    var ms = s > 0 && s <= 3600 ? s * 1000 : 60000;
    bloqueadoAte = Date.now() + ms;
    avisar(NOME + ": limite da API atingido, enviando sem correção por " + Math.round(ms / 1000) + "s");
  }

  function avisarFalha(erro) {
    var motivo = String((erro && erro.message) || erro);
    if (motivo === "cancelada") return;
    var agora = Date.now();
    if (agora - ultimoAviso < 8000) return;
    ultimoAviso = agora;
    avisar(NOME + ": enviada como digitada (" + motivo.slice(0, 40) + ")");
  }

  function erroHttp(status, corpo, depoisDe) {
    corpo = corpo || "";
    var limite = status === 429 || /RESOURCE_EXHAUSTED/.test(corpo);
    var e = new Error(limite ? "limite da API atingido (HTTP " + status + ")" : "HTTP " + status);
    var m = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)/.exec(corpo);
    e.status = status;
    e.limiteApi = limite;
    e.espera = Number(depoisDe) > 0 ? Number(depoisDe) : m ? Math.ceil(Number(m[1])) : 0;
    return e;
  }

  function enviarPedido(texto) {
    if (!configurado()) return Promise.reject(new Error("não configurado"));
    var controlador = typeof AbortController === "function" ? new AbortController() : null;
    var item = { cancelar: null };

    var pedido = fetch(storage.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + storage.chave,
      },
      body: JSON.stringify({
        model: storage.modelo,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: texto },
        ],
      }),
      signal: controlador ? controlador.signal : undefined,
    })
      .then(function (r) {
        if (!r.ok) {
          var espera = null;
          try {
            espera = r.headers && r.headers.get ? r.headers.get("retry-after") : null;
          } catch (e) {}
          return r.text().then(
            function (corpo) {
              throw erroHttp(r.status, corpo, espera);
            },
            function () {
              throw erroHttp(r.status, "", espera);
            }
          );
        }
        return r.json();
      })
      .then(function (d) {
        var c = d && d.choices && d.choices[0];
        var t = c && c.message && c.message.content;
        if (typeof t !== "string" || !t) throw new Error("resposta vazia");
        return t;
      });

    var cancelada = new Promise(function (_, rejeitar) {
      item.cancelar = function () {
        try {
          if (controlador) controlador.abort();
        } catch (e) {}
        rejeitar(new Error("cancelada"));
      };
    });
    emVoo.push(item);

    function fim() {
      var i = emVoo.indexOf(item);
      if (i >= 0) emVoo.splice(i, 1);
    }

    return Promise.race([pedido, cancelada]).then(
      function (v) {
        fim();
        return v;
      },
      function (e) {
        fim();
        throw e;
      }
    );
  }

  function chamarApi(texto) {
    return enviarPedido(texto).then(null, function (e) {
      if (e && e.status === 503 && vivo) {
        return new Promise(function (resolver) {
          setTimeout(resolver, 700);
        }).then(function () {
          if (!vivo) throw e;
          return enviarPedido(texto);
        });
      }
      throw e;
    });
  }

  function dividirTexto(texto) {
    var palavras = [];
    var entres = [];
    var ultimo = 0;
    var m;
    PALAVRA.lastIndex = 0;
    while ((m = PALAVRA.exec(texto)) !== null) {
      entres.push(texto.slice(ultimo, m.index));
      palavras.push(m[0]);
      ultimo = m.index + m[0].length;
    }
    entres.push(texto.slice(ultimo));
    return { palavras: palavras, entres: entres };
  }

  function juntarEntre(entreIn, entreOut, inicio) {
    var desejados = entreIn.replace(/[\s.,;:~]/g, "");
    var pos = 0;
    var resultadoGap = "";
    var removeu = false;
    for (var i = 0; i < entreOut.length; i++) {
      var ch = entreOut.charAt(i);
      if (CHAR_ENTRE.test(ch)) resultadoGap += ch;
      else if (pos < desejados.length && ch === desejados.charAt(pos)) {
        resultadoGap += ch;
        pos++;
      } else removeu = true;
    }
    if (pos < desejados.length) return entreIn;
    if (removeu) resultadoGap = resultadoGap.replace(/[ \t]+/g, " ").replace(/ +([.,;:~])/g, "$1");
    resultadoGap = resultadoGap.replace(/([?!])\.+/g, "$1");
    if (contar(/\n/g, resultadoGap) !== contar(/\n/g, entreIn)) return entreIn;
    if (/\s/.test(entreIn) && !/\s/.test(resultadoGap)) return entreIn;
    var sinais = contar(/[.,;:~]/g, resultadoGap);
    var sinaisIn = contar(/[.,;:~]/g, entreIn);
    if (sinais > Math.max(3, sinaisIn)) return entreIn;
    if (inicio && sinais > sinaisIn) return entreIn;
    return resultadoGap;
  }

  function juntarResposta(entrada, resposta) {
    if (typeof resposta !== "string") return null;
    resposta = resposta.replace(/^\s+|\s+$/g, "");
    try {
      if (resposta.normalize) resposta = resposta.normalize("NFC");
    } catch (e) {}
    var a = dividirTexto(entrada);
    var b = dividirTexto(resposta);
    if (!b.palavras.length || a.palavras.length !== b.palavras.length) return null;
    var trocadas = 0;
    var finais = [];
    for (var i = 0; i < a.palavras.length; i++) {
      var original = a.palavras[i];
      var corrigida = b.palavras[i];
      if (chavePalavra(corrigida) === chavePalavra(original)) {
        if (/^porque$/i.test(original)) corrigida = corrigida.replace(/ê/g, "e").replace(/Ê/g, "E");
        finais.push(corrigida);
      } else {
        trocadas++;
        finais.push(original);
      }
    }
    if (trocadas * 3 > finais.length) return null;
    var resultado = "";
    for (var j = 0; j < finais.length; j++) {
      resultado += juntarEntre(a.entres[j], b.entres[j], j === 0) + finais[j];
    }
    return resultado + juntarEntre(a.entres[finais.length], b.entres[finais.length], false);
  }

  function ehLetra(c) {
    return c.toLowerCase() !== c.toUpperCase();
  }

  function ehMaiuscula(c) {
    return c !== c.toLowerCase();
  }

  function inicioDeFrase(antes) {
    return /(^|[.!?]["')\]]*\s+|\n\s*)$/.test(antes);
  }

  function ajustarCaixa(entrada, saida) {
    var letras = [];
    var i;
    for (i = 0; i < entrada.length; i++) {
      if (ehLetra(entrada.charAt(i))) letras.push(entrada.charAt(i));
    }
    var resultado = "";
    var k = 0;
    i = 0;
    while (i < saida.length) {
      var c = saida.charAt(i);
      if (!ehLetra(c)) {
        resultado += c;
        i++;
        continue;
      }
      var comeco = i;
      var k0 = k;
      while (i < saida.length && ehLetra(saida.charAt(i))) {
        i++;
        k++;
      }
      var caracteres = saida.slice(comeco, i).split("");
      var tinhaMaiuscula = false;
      for (var j = 0; j < caracteres.length; j++) {
        var e = letras[k0 + j];
        if (e === undefined) return saida;
        if (ehMaiuscula(e)) {
          tinhaMaiuscula = true;
          caracteres[j] = caracteres[j].toUpperCase();
        }
      }
      var palavra = caracteres.join("");
      if (!tinhaMaiuscula && palavra.length >= 2 && palavra === palavra.toUpperCase()) {
        palavra = palavra.toLowerCase();
        if (inicioDeFrase(resultado)) palavra = palavra.charAt(0).toUpperCase() + palavra.slice(1);
      }
      resultado += palavra;
    }
    if (k !== letras.length) return saida;
    return resultado;
  }

  function restaurar(texto, guardados) {
    guardados.forEach(function (original, i) {
      texto = texto.split("\u00a7" + i + "\u00a7").join(original);
    });
    return texto;
  }

  function guardarCache(k, v) {
    if (cache[k] === undefined) {
      chavesCache.push(k);
      if (chavesCache.length > 40) delete cache[chavesCache.shift()];
    }
    cache[k] = v;
  }

  function corrigir(texto) {
    var abertura = /^\s*/.exec(texto)[0];
    var fechamento = /\s*$/.exec(texto)[0];
    var miolo = texto.slice(abertura.length, texto.length - fechamento.length);
    var guardados = [];
    var protegido = miolo.replace(PROTEGER, function (m) {
      guardados.push(m);
      return "\u00a7" + (guardados.length - 1) + "\u00a7";
    });
    if (!/[A-Za-z\u00c0-\u00ff]/.test(protegido.replace(MARCADOR, ""))) return Promise.resolve(texto);
    var chaveCache = "k" + protegido;
    if (cache[chaveCache] !== undefined) return Promise.resolve(abertura + restaurar(cache[chaveCache], guardados) + fechamento);
    return chamarApi(protegido).then(
      function (resposta) {
        var unido = juntarResposta(protegido, resposta);
        if (!unido) return texto;
        unido = ajustarCaixa(protegido, unido);
        bloqueadoAte = 0;
        guardarCache(chaveCache, unido);
        return abertura + restaurar(unido, guardados) + fechamento;
      },
      function (erro) {
        if (erro && erro.limiteApi) marcarLimite(erro);
        else avisarFalha(erro);
        return texto;
      }
    );
  }

  function ativo() {
    if (!vivo) return false;
    if (G.__grammify && G.__grammify.id !== idInstancia) return false;
    try {
      var lista = vendetta.plugins && vendetta.plugins.plugins;
      var p = lista && vendetta.plugin && lista[vendetta.plugin.id];
      if (p && p.enabled === false) return false;
    } catch (e) {}
    return true;
  }

  function encerrar() {
    vivo = false;
    cancelarPendentes();
    desfazer.forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
    desfazer = [];
  }

  function instalarPatch() {
    var acoes = metro.findByProps("sendMessage", "editMessage");
    if (!acoes) throw new Error("sendMessage não encontrado");
    desfazer.push(
      patcher.instead("sendMessage", acoes, function (args, original) {
        var proprio = this;
        var msg = args[1];
        var texto = msg && msg.content;
        var precisaCorrigir = false;
        try {
          precisaCorrigir = ativo() && !!storage.ligada && typeof texto === "string" && configurado() && !motivoPular(texto);
        } catch (e) {
          precisaCorrigir = false;
        }
        if (!precisaCorrigir && pendentes === 0) return original.apply(proprio, args);

        pendentes++;
        var tarefa = fila.then(function () {
          var passo;
          try {
            passo = precisaCorrigir && ativo() ? corrigir(texto) : Promise.resolve(texto);
          } catch (e) {
            passo = Promise.resolve(texto);
          }
          return passo
            .then(null, function () {
              return texto;
            })
            .then(function (novo) {
              if (novo !== texto) msg.content = novo;
              return original.apply(proprio, args);
            });
        });
        var terminar = function () {
          pendentes--;
        };
        fila = tarefa.then(terminar, terminar);
        return tarefa;
      })
    );
  }

  function aquecer() {
    try {
      if (!configurado()) return;
      fetch(String(storage.url).replace(/\/chat\/completions\/?$/, "/models"), {
        method: "GET",
        headers: { Authorization: "Bearer " + storage.chave },
      }).then(null, function () {});
    } catch (e) {}
  }

  function h() {
    return metro.common.React.createElement.apply(metro.common.React, arguments);
  }

  function RN() {
    return metro.common.ReactNative;
  }

  function cores() {
    var claro = false;
    var tema = null;
    var meta = null;
    var sc = vendetta.ui.semanticColors || {};
    try {
      tema = metro.findByStoreName("ThemeStore");
      claro = !!tema && tema.theme === "light";
    } catch (e) {}
    try {
      meta = metro.findByProps("colors", "meta").meta;
    } catch (e) {}
    function escolher(nomeCor, escuro, corClara) {
      try {
        var c = meta.resolveSemanticColor(tema.theme, sc[nomeCor]);
        if (typeof c === "string" && c) return c;
      } catch (e) {}
      return claro ? corClara : escuro;
    }
    return {
      texto: escolher("TEXT_NORMAL", "#f2f3f5", "#060607"),
      mudo: escolher("TEXT_MUTED", "#b5bac1", "#5c5e66"),
      cartao: escolher("BACKGROUND_SECONDARY", "#2b2d31", "#f2f3f5"),
      campo: escolher("BACKGROUND_TERTIARY", "#1e1f22", "#e3e5e8"),
      borda: escolher("BACKGROUND_MODIFIER_ACCENT", "#4e5058", "#c4c9ce"),
      destaque: "#5865f2",
      perigo: "#da373c",
      sucesso: "#23a55a",
    };
  }

  function Cartao(props) {
    var c = cores();
    return h(
      RN().View,
      { style: { backgroundColor: c.cartao, borderRadius: 12, marginBottom: 12, padding: 14 } },
      props.titulo ? h(RN().Text, { style: { color: c.texto, fontSize: 16, fontWeight: "700" } }, props.titulo) : null,
      props.children
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
        if (props.aoMudar) props.aoMudar(v);
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
    return h(
      RN().Pressable,
      {
        testID: props.testID,
        onPress: props.aoTocar,
        style: {
          backgroundColor: props.secundario ? c.campo : c.destaque,
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

  function Painel() {
    var R = metro.common.React;
    var versao = R.useState(0);
    var mostrar = R.useState(false);
    var c = cores();
    function atualizar() {
      versao[1](function (n) {
        return n + 1;
      });
    }
    var rotulos = { url: "URL", chave: "chave da API", modelo: "modelo" };
    var ausentes = faltando().map(function (k) {
      return rotulos[k];
    });
    var v = versao[0];
    return h(
      RN().ScrollView,
      { keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 12, paddingBottom: 80 } },
      h(
        RN().View,
        { style: { marginBottom: 12, paddingHorizontal: 4 } },
        h(RN().Text, { style: { color: c.texto, fontSize: 18, fontWeight: "700" } }, NOME),
        h(
          RN().Text,
          { style: { color: ausentes.length ? c.perigo : c.sucesso, fontSize: 13, marginTop: 4 } },
          ausentes.length ? "Faltando: " + ausentes.join(", ") : "Pronto"
        )
      ),
      h(
        Cartao,
        {},
        h(Item, {
          nome: "Ativado",
          nota: "Corrige as mensagens antes de enviar.",
          lado: h(Interruptor, {
            campo: "ligada",
            testID: "alternar-ligada",
            aoMudar: function (ligado) {
              if (!ligado) cancelarPendentes();
            },
          }),
        })
      ),
      h(
        Cartao,
        { titulo: "API de IA" },
        h(
          RN().View,
          { style: { flexDirection: "row", flexWrap: "wrap" } },
          h(Botao, {
            testID: "btn-gemini",
            texto: "Usar Gemini",
            aoTocar: function () {
              storage.url = GEMINI_URL;
              storage.modelo = GEMINI_MODELO;
              atualizar();
            },
          })
        ),
        h(Item, {
          nome: "URL",
          corpo: h(Campo, {
            key: "url" + v,
            testID: "campo-url",
            valor: storage.url,
            dica: "https://...",
            teclado: "url",
            aoMudar: function (t) {
              storage.url = String(t).trim();
              atualizar();
            },
          }),
        }),
        h(Item, {
          nome: "Modelo",
          corpo: h(Campo, {
            key: "modelo" + v,
            testID: "campo-modelo",
            valor: storage.modelo,
            dica: GEMINI_MODELO,
            aoMudar: function (t) {
              storage.modelo = String(t).trim();
              atualizar();
            },
          }),
        }),
        h(Item, {
          nome: "Chave da API",
          corpo: h(
            RN().View,
            {},
            h(Campo, {
              key: "chave" + v + (mostrar[0] ? "m" : "o"),
              testID: "campo-chave",
              valor: storage.chave,
              dica: "cole a chave aqui",
              segredo: !mostrar[0],
              aoMudar: function (t) {
                storage.chave = String(t).trim();
                atualizar();
              },
            }),
            h(
              RN().View,
              { style: { flexDirection: "row", flexWrap: "wrap" } },
              h(Botao, {
                testID: "btn-colar",
                texto: "Colar",
                aoTocar: function () {
                  try {
                    metro.common.clipboard.getString().then(function (t) {
                      t = String(t || "").trim();
                      if (!t) return avisar("A área de transferência está vazia");
                      storage.chave = t;
                      atualizar();
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
        })
      )
    );
  }

  return {
    onLoad: function () {
      ["__corretor", "__grammify"].forEach(function (k) {
        try {
          var antigo = G[k];
          if (antigo && typeof antigo.desligar === "function") antigo.desligar();
          else if (antigo && typeof antigo.shutdown === "function") antigo.shutdown();
        } catch (e) {}
      });
      G.__grammify = { id: idInstancia, desligar: encerrar };
      vivo = true;
      if (storage.url === undefined && storage.apiUrl) storage.url = storage.apiUrl;
      if (storage.chave === undefined && storage.apiKey) storage.chave = storage.apiKey;
      if (storage.modelo === undefined && storage.model) storage.modelo = storage.model;
      if (storage.ligada === undefined) storage.ligada = storage.enabled === undefined ? true : !!storage.enabled;
      try {
        instalarPatch();
      } catch (e) {
        vivo = false;
        throw e;
      }
      aquecer();
    },
    onUnload: function () {
      encerrar();
      try {
        if (G.__grammify && G.__grammify.id === idInstancia) G.__grammify = null;
      } catch (e) {}
    },
    settings: Painel,
  };
})();
