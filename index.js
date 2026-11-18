(function () {
  "use strict";
  // ATENCAO: o primeiro caractere deste arquivo precisa ser "(" (sem comentario ou linha em branco antes).

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var storage = vendetta.plugin.storage;
  var commands = vendetta.commands;
  var showToast = vendetta.ui.toasts.showToast;

  var VERSAO = "0.5";
  var LIMITE_CARACTERES = 1500;
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

  var desfazer = []; // funcoes que desfazem patches e comandos
  var fila = Promise.resolve();
  var pendentes = 0;
  var ultimoMotivo = "nenhuma ainda";
  var ultimaEntrada = "";
  var ultimaResposta = "";
  var ultimaDuracao = 0;
  var tempos = []; // duracao (s) das ultimas respostas da API
  var contagem = { ok: 0, recusadas: 0, falhas: 0 };

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

  function limiteSeg() {
    return Number(storage.limite) || 6;
  }

  function estado() {
    var t = "Corretor v" + VERSAO + ": " + (storage.ligada ? "ligado" : "desligado");
    t += ", crase " + (storage.crase ? "LIGADA" : "desligada");
    t += ", limite " + limiteSeg() + "s";
    var f = faltando();
    if (f.length) t += " (falta: " + f.join(", ") + ")";
    return t;
  }

  function guardarTempo(seg) {
    tempos.push(seg);
    if (tempos.length > 50) tempos.shift();
  }

  function resumo() {
    var t = "Corrigidas " + contagem.ok + ", recusadas pelo filtro " + contagem.recusadas +
      ", falhas/tempo esgotado " + contagem.falhas;
    if (tempos.length) {
      var soma = 0, max = 0;
      tempos.forEach(function (x) {
        soma += x;
        if (x > max) max = x;
      });
      t += " | resposta da IA: média " + (soma / tempos.length).toFixed(1) + "s, máx " + max.toFixed(1) + "s (" + tempos.length + " respostas)";
    }
    return t;
  }

  function cortar(t) {
    t = String(t).replace(/\n/g, " / ");
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
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

  function deveCorrigir(t) {
    if (!t.replace(/\s/g, "")) return false;
    if (t.length > LIMITE_CARACTERES) return false;
    // nao mexe em comandos: s/velho/novo, +:emoji:, /comando
    return !/^(s\/|\+:|\/)/.test(t);
  }

  function montarPrompt() {
    return [
      "Você é um revisor de mensagens de chat em português. A mensagem foi digitada de qualquer jeito (sem acentos, sem pontuação, sem maiúsculas). Devolva a MESMA mensagem corrigida, fazendo um trabalho COMPLETO nestes três itens, sem deixar nada para trás:",
      "1) ACENTOS: coloque todos os acentos e cedilhas que as palavras exigem (você, não, amanhã, já, é, está, tá, né, pão, vídeo...). Leia a frase inteira para decidir entre palavras parecidas (e/é, esta/está, ja/já).",
      "2) MAIÚSCULAS: a primeira letra de cada frase e os nomes próprios (pessoas, lugares, marcas).",
      "3) PONTUAÇÃO: ponto final no fim de toda frase afirmativa; vírgulas onde a gramática pede (vocativos, listas, orações, expressões como então, porém, né). Você também pode usar dois-pontos (:), ponto e vírgula (;) e til (~) quando fizerem sentido. Só deixe sem ponto final se a frase for CLARAMENTE uma pergunta (nesse caso, sem ponto final e sem interrogação).",
      "PROIBIDO: trocar, remover, adicionar, juntar, separar ou reordenar palavras; corrigir gírias, abreviações (vc, tb, blz, kkk) ou erros de digitação; mudar o tom; adicionar emojis, exclamações ou interrogações; mexer em porque/por que/porquê, mas/mais, a/há.",
      storage.crase
        ? "Use crase (à, às, àquele) quando a gramática exigir."
        : "NÃO use crase.",
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

  // ---------- chamada da API (com tempo limite) ----------

  function chamarApi(texto) {
    if (faltando().length) return Promise.reject(new Error("falta configurar"));
    if (String(storage.url).indexOf("https://") !== 0) {
      return Promise.reject(new Error("url precisa começar com https://"));
    }
    var limiteMs = limiteSeg() * 1000;
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
        if (!r.ok) throw new Error("HTTP " + r.status);
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

  function corrigir(texto) {
    var guardados = [];
    var protegido = texto.replace(PROTEGER, function (m) {
      guardados.push(m);
      return "\u00a7" + (guardados.length - 1) + "\u00a7";
    });
    if (!/[A-Za-z\u00c0-\u00ff]/.test(protegido.replace(MARCADOR, ""))) {
      return Promise.resolve(texto);
    }
    ultimaEntrada = texto;
    ultimaResposta = "";
    var inicio = Date.now();
    return chamarApi(protegido).then(
      function (resposta) {
        ultimaDuracao = (Date.now() - inicio) / 1000;
        ultimaResposta = typeof resposta === "string" ? resposta : "";
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
        guardarTempo(ultimaDuracao);
        if (motivo) {
          contagem.recusadas++;
          ultimoMotivo = motivo;
          return texto;
        }
        var corrigido = resposta.replace(/^\s+|\s+$/g, "");
        guardados.forEach(function (original, i) {
          corrigido = corrigido.split("\u00a7" + i + "\u00a7").join(original);
        });
        contagem.ok++;
        ultimoMotivo = "ok";
        return corrigido;
      },
      function (erro) {
        ultimaDuracao = (Date.now() - inicio) / 1000;
        contagem.falhas++;
        ultimoMotivo = String((erro && erro.message) || erro);
        return texto;
      }
    );
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
        var precisa =
          storage.ligada && !faltando().length && typeof texto === "string" && deveCorrigir(texto);
        // Mantem a ordem das mensagens: se ha algo na fila, tudo entra na fila.
        if (!precisa && pendentes === 0) return original.apply(self, args);

        pendentes++;
        var tarefa = fila.then(function () {
          var passo = precisa ? corrigir(texto) : Promise.resolve(texto);
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

  function opcao(nome, descricao) {
    return {
      name: nome,
      displayName: nome,
      description: descricao,
      displayDescription: descricao,
      required: false,
      type: 3,
    };
  }

  function registrar(nome, descricao, opcoes, executar) {
    desfazer.push(
      commands.registerCommand({
        name: nome,
        displayName: nome,
        description: descricao,
        displayDescription: descricao,
        options: opcoes,
        applicationId: "-1",
        inputType: 1,
        type: 1,
        execute: executar,
      })
    );
  }

  function registrarComandos() {
    registrar("correcao_ligar", "Liga a correção das suas mensagens", [], function () {
      storage.ligada = true;
      avisar(estado());
    });
    registrar("correcao_desligar", "Desliga a correção das suas mensagens", [], function () {
      storage.ligada = false;
      avisar(estado());
    });
    registrar("correcao_status", "Mostra se a correção está ligada e o resultado da última", [], function () {
      avisar(estado() + " | última: " + ultimoMotivo);
    });
    registrar("correcao_ultima", "Mostra o que a IA devolveu na última mensagem, se foi aceita e quanto demorou", [], function () {
      avisar(
        "Você: " + cortar(ultimaEntrada) + " | IA: " + cortar(ultimaResposta) + " | " + ultimoMotivo +
          " (" + ultimaDuracao.toFixed(1) + "s) | crase " + (storage.crase ? "LIGADA" : "desligada")
      );
    });
    registrar(
      "correcao_estatisticas",
      "Mostra tempo médio/máximo da IA e quantas mensagens foram corrigidas, recusadas ou falharam",
      [opcao("zerar", "Digite sim para zerar as estatísticas")],
      function (args) {
        var zerar = (args || []).some(function (a) {
          return a.name === "zerar" && String(a.value).toLowerCase() === "sim";
        });
        if (zerar) {
          tempos = [];
          contagem = { ok: 0, recusadas: 0, falhas: 0 };
          avisar("Estatísticas zeradas");
          return;
        }
        avisar(resumo());
      }
    );
    registrar("correcao_crase_ligar", "Liga a crase", [], function () {
      storage.crase = true;
      avisar(estado());
    });
    registrar("correcao_crase_desligar", "Desliga a crase", [], function () {
      storage.crase = false;
      avisar(estado());
    });
    registrar(
      "correcao_api",
      "Define a API de IA (url https, modelo, chave e tempo limite)",
      [
        opcao("url", "Endereço da API (começa com https://)"),
        opcao("modelo", "Nome do modelo"),
        opcao("chave", "Chave da API"),
        opcao("limite", "Tempo máximo de espera, em segundos (1 a 30)"),
      ],
      function (args) {
        var salvos = [];
        (args || []).forEach(function (a) {
          var valor = String(a.value || "").replace(/^\s+|\s+$/g, "");
          if (!valor) return;
          if (a.name === "url") {
            if (valor.indexOf("https://") !== 0) {
              avisar("A url precisa começar com https://");
              return;
            }
            storage.url = valor;
            salvos.push("url");
          } else if (a.name === "modelo") {
            storage.modelo = valor;
            salvos.push("modelo");
          } else if (a.name === "limite") {
            var n = Number(String(valor).replace(",", "."));
            if (!(n >= 1 && n <= 30)) {
              avisar("O limite precisa ser um número de 1 a 30");
              return;
            }
            storage.limite = n;
            salvos.push("limite");
          } else if (a.name === "chave") {
            storage.chave = valor;
            salvos.push("chave");
          }
        });
        avisar((salvos.length ? "Salvo: " + salvos.join(", ") + ". " : "Nada salvo. ") + estado());
      }
    );
  }

  return {
    onLoad: function () {
      if (storage.ligada === undefined) storage.ligada = true;
      if (storage.crase === undefined) storage.crase = false;
      if (storage.limite === undefined) storage.limite = 6;
      instalarPatch(); // se falhar, o plugin se desliga e avisa
      try {
        registrarComandos();
      } catch (e) {
        avisar("Corretor: erro ao criar os comandos: " + (e && e.message));
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
  };
})()
