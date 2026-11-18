(function () {
  "use strict";
  // ATENCAO: o primeiro caractere deste arquivo precisa ser "(" (sem comentario ou linha em branco antes).

  var metro = vendetta.metro;
  var patcher = vendetta.patcher;
  var storage = vendetta.plugin.storage;
  var commands = vendetta.commands;
  var showToast = vendetta.ui.toasts.showToast;

  var LIMITE_CARACTERES = 1500;
  // Trechos que a IA nunca ve nem mexe: codigo, mencoes, emojis, links, numeros/horas/datas.
  var PROTEGER = /```[\s\S]*?```|`[^`\n]*`|<[^>\n]+>|https?:\/\/\S+|:[A-Za-z0-9_]+:|\d+(?:[.,:\/-]\d+)+/g;
  var MARCADOR = /\u27e6\d+\u27e7/g;
  var DE = "áàâãäåéèêëíìîïóòôõöúùûüçñ";
  var PARA = "aaaaaaeeeeiiiiooooouuuucn";

  var desfazer = []; // funcoes que desfazem patches e comandos
  var fila = Promise.resolve();
  var pendentes = 0;
  var ultimoMotivo = "nenhuma ainda";

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

  function estado() {
    var t = storage.ligada ? "Correção ligada" : "Correção desligada";
    t += storage.crase ? ", com crase" : ", sem crase";
    var f = faltando();
    if (f.length) t += " (falta: " + f.join(", ") + ")";
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

  function deveCorrigir(t) {
    if (!t.replace(/\s/g, "")) return false;
    if (t.length > LIMITE_CARACTERES) return false;
    // nao mexe em comandos: s/velho/novo, +:emoji:, /comando
    return !/^(s\/|\+:|\/)/.test(t);
  }

  function montarPrompt() {
    return [
      "Você é um revisor mínimo de mensagens de chat em português. Devolva o MESMO texto, mudando SOMENTE:",
      "1) acentos e cedilha em palavras que você tem certeza que levam acento (leia a frase inteira; na dúvida, deixe como está);",
      "2) letra maiúscula no início das frases e em nomes próprios;",
      "3) ponto final e vírgula onde claramente cabem. Você também pode usar dois-pontos (:), ponto e vírgula (;) e til (~) quando fizerem sentido; na dúvida, não use. Se a frase parecer uma pergunta, NÃO coloque ponto final nem interrogação.",
      "REGRAS: não troque, remova, adicione nem reordene nenhuma palavra, e não junte nem separe palavras. " +
        "Não corrija gírias, abreviações (vc, tb, blz) nem erros de digitação. Não mude o tom. " +
        "Não mexa em porque/por que/porquê, mas/mais, a/há. " +
        "Não adicione emojis, exclamações nem interrogações.",
      storage.crase
        ? "Use crase (à, às, àquele) quando a gramática exigir e você tiver certeza."
        : "NÃO use crase.",
      "Se o texto não estiver em português, devolva-o exatamente igual.",
      "Mantenha as quebras de linha e os marcadores \u27e6número\u27e7 exatamente onde estão.",
      "Responda somente com o texto final, sem aspas e sem comentários.",
    ].join("\n");
  }

  // ---------- chamada da API (com tempo limite) ----------

  function chamarApi(texto) {
    if (faltando().length) return Promise.reject(new Error("falta configurar"));
    if (String(storage.url).indexOf("https://") !== 0) {
      return Promise.reject(new Error("url precisa começar com https://"));
    }
    var limiteMs = (Number(storage.limite) || 4) * 1000;
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
      if (contar(new RegExp("\u27e6" + i + "\u27e7", "g"), saida) !== 1) {
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
      return "\u27e6" + (guardados.length - 1) + "\u27e7";
    });
    if (!/[A-Za-z\u00c0-\u00ff]/.test(protegido.replace(MARCADOR, ""))) {
      return Promise.resolve(texto);
    }
    return chamarApi(protegido).then(
      function (resposta) {
        var motivo = validar(protegido, resposta, guardados.length);
        if (motivo) {
          ultimoMotivo = motivo;
          return texto;
        }
        var corrigido = resposta.replace(/^\s+|\s+$/g, "");
        guardados.forEach(function (original, i) {
          corrigido = corrigido.split("\u27e6" + i + "\u27e7").join(original);
        });
        ultimoMotivo = "ok";
        return corrigido;
      },
      function (erro) {
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
    registrar("correcao_crase", "Liga ou desliga o uso de crase pela IA", [], function () {
      storage.crase = !storage.crase;
      avisar(estado());
    });
    registrar(
      "correcao_api",
      "Define a API de IA (url https, modelo e chave)",
      [
        opcao("url", "Endereço da API (começa com https://)"),
        opcao("modelo", "Nome do modelo"),
        opcao("chave", "Chave da API"),
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
      if (storage.limite === undefined) storage.limite = 4;
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
