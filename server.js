require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const app = express();
const nodemailer = require('nodemailer');

app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});


// --- CADASTRO ---

async function enviarEmailBoasVindas(dados) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const corpoHtml = `
        <div style="background-color: #121212; color: #ffffff; padding: 20px; font-family: sans-serif; border-radius: 10px;">
            <h1 style="color: #4CAF50;">⚽ Bem-vindo à Arena, ${dados.nome}!</h1>
            <p>Seu cadastro no <strong>Bolão da NAZ 2026</strong> foi realizado com sucesso.</p>
            <div style="background: #1a1a1a; padding: 15px; border-left: 4px solid #4CAF50; margin: 20px 0;">
                <p><strong>Seus dados de acesso:</strong></p>
                <p>Apelido: <span style="color: #ffc107;">${dados.apelido}</span></p>
                <p>Senha: <span style="color: #ffc107;">${dados.senha}</span></p>
                <p>CPF: ${dados.id}</p>
            </div>
            <p style="font-size: 12px; color: #888;">Guarde este e-mail para consultas futuras.</p>
        </div>
    `;

    return transporter.sendMail({
        from: `"Bolão da NAZ" <${process.env.EMAIL_USER}>`,
        to: dados.email,
        subject: '🚀 Cadastro Confirmado - Bolão da NAZ 2026',
        html: corpoHtml
    });

}

app.post('/cadastrar', async (req, res) => {
    const { id, nome, apelido, senha, time, celular, email } = req.body; 

    try {
        const usuarioExistente = await db.execute({
            sql: "SELECT ID FROM dLogin WHERE ID = ?",
            args: [id]
        });

        if (usuarioExistente.rows.length > 0) {
            return res.json({ success: false, message: "CPF já cadastrado." });
        }

        await db.execute({
	   sql: "INSERT INTO dLogin (ID, Nome, Apelido, Senha, Time, Celular, [e-mail]) VALUES (?, ?, ?, ?, ?, ?, ?)",
           args: [id, nome, apelido, senha, time, celular || "", email || ""]
        });

        const jogos = await db.execute("SELECT Jogo, Sel1, Sel2, Data, Horario FROM dTabela");

	for (const jogo of jogos.rows) {
            await db.execute({
                sql: "INSERT INTO dApostas (ID, Apelido, Jogo, Sel1, Sel2, Data, Horario) VALUES (?, ?, ?, ?, ?, ?, ?)",
                args: [id, apelido, jogo.Jogo, jogo.Sel1, jogo.Sel2, jogo.Data, jogo.Horario]
            });
        }

	if (email) {
            try {
                await enviarEmailBoasVindas({ id, nome, apelido, senha, email });
            } catch (mailError) {
                console.error("Erro ao enviar e-mail, mas cadastro foi feito:", mailError);
                // Não travamos o cadastro se o e-mail falhar, mas avisamos no log
            }
        }
        res.json({ success: true, message: "Cadastro realizado! Verifique seu e-mail." });
    } catch (e) {
        console.error("Erro no cadastro:", e);
        res.status(500).json({ success: false, message: "Erro ao processar base de dados." });
    }
});

// --- LOGIN ---
app.post('/login', async (req, res) => {
    const { apelido, senha } = req.body;
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dLogin WHERE Apelido = ? AND Senha = ?",
            args: [apelido, senha]
        });
        
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] }); 
        } else {
            res.json({ success: false, message: "Credenciais incorretas." });
        }
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- PRESENÇA (PING) ---
app.post('/api/ping', async (req, res) => {
    const { apelido } = req.body;
    if (!apelido) return res.status(400).json({ success: false });

    try {
        // Atualiza a coluna InOut com o horário atual do servidor para marcar presença
        await db.execute({
            sql: "UPDATE dLogin SET InOut = datetime('now', 'localtime') WHERE Apelido = ?",
            args: [apelido]
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Erro ao registrar ping:", e);
        res.status(500).json({ success: false });
    }
});

// --- PALPITES ---
app.get('/minhas-apostas/:apelido', async (req, res) => {
    try {
        const result = await db.execute({
            sql: "SELECT * FROM dApostas WHERE Apelido = ? ORDER BY Data, Horario",
            args: [req.params.apelido]
        });
        res.json({ success: true, apostas: result.rows });
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

// --- PALPITES (Versão atualizada para salvar em lote com Correção de Fuso) ---
app.post('/salvar-palpite', async (req, res) => {
    const { apelido, palpites } = req.body; // Agora espera receber 'palpites' como array

    try {
        const statements = [];
        const agora = new Date(); // Pega o timestamp universal atual

        for (const p of palpites) {
            // Verifica o tempo de cada jogo individualmente por segurança
            const info = await db.execute({
                sql: "SELECT Data, Horario FROM dTabela WHERE Jogo = ?",
                args: [p.jogo]
            });

            if (info.rows.length > 0) {
                const dataJogo = info.rows[0].Data; // Ex: 2026-06-15
                const horaJogo = info.rows[0].Horario; // Ex: 16:00
                
                // 1. Garante que a data use hífens e força o fuso horário de Brasília (-03:00)
                const dataFormatada = dataJogo.replace(/\//g, '-');
                const limite = new Date(`${dataFormatada}T${horaJogo}:00-03:00`);
                
                // Subtrai os 10 minutos de tolerância
                limite.setMinutes(limite.getMinutes() - 10);

                // 2. Comparação justa de Timestamps (Independe de onde o servidor está hospedado)
                if (agora <= limite) {
                    statements.push({
                        sql: "UPDATE dApostas SET Ap1 = ?, Ap2 = ? WHERE Apelido = ? AND Jogo = ?",
                        args: [p.ap1, p.ap2, apelido, p.jogo]
                    });
                }
            }
        }

        if (statements.length > 0) {
            // Executa todas as atualizações de uma só vez
            await db.batch(statements);
            res.json({ success: true, message: `${statements.length} palpite(s) atualizado(s) com sucesso!` });
        } else {
            // Caso o usuário tente enviar palpites mas todos já estejam bloqueados pelo horário
            res.json({ success: false, message: "Tempo esgotado para todos os jogos enviados!" });
        }

    } catch (e) {
        console.error("Erro ao salvar palpites em lote:", e);
        res.status(500).json({ success: false, message: "Erro interno ao processar lote." });
    }
});

// --- CHAT (24 Horas) ---
app.get('/get-chat', async (req, res) => {
    try {
        await db.execute("DELETE FROM dChat WHERE DataHora < datetime('now', '-1 day')");
        const result = await db.execute("SELECT Apelido, Mensagem FROM dChat ORDER BY ID ASC LIMIT 50");
        res.json({ success: true, mensagens: result.rows });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/enviar-msg', async (req, res) => {
    const { apelido, mensagem } = req.body;
    if(!apelido || !mensagem) return res.status(400).json({ success: false });

    try {
        await db.execute({
            sql: "INSERT INTO dChat (Apelido, Mensagem) VALUES (?, ?)",
            args: [apelido, mensagem]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// --- ADMIN: JOGOS E RESULTADOS ---
app.get('/api/admin/jogos', async (req, res) => {
    try {
        const sql = `
            SELECT t.Jogo, t.Data, t.Horario, t.Sel1, t.Sel2, r.Res1, r.Res2
            FROM dTabela t
            LEFT JOIN dResult r ON t.Jogo = r.Jogo
            ORDER BY t.Data, t.Horario
        `;
        const result = await db.execute(sql);
        res.json({ success: true, jogos: result.rows });
    } catch (e) {
        console.error("Erro ao buscar jogos admin:", e);
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/atualizar_resultado', async (req, res) => {
    const { jogo, res1, res2 } = req.body;
    const r1 = parseInt(res1); // Gols Real Time A
    const r2 = parseInt(res2); // Gols Real Time B

    try {
        // 1. Atualiza ou insere o resultado oficial
        await db.execute({
            sql: "INSERT INTO dResult (Jogo, Res1, Res2) VALUES (?, ?, ?) ON CONFLICT(Jogo) DO UPDATE SET Res1=excluded.Res1, Res2=excluded.Res2",
            args: [jogo, r1, r2]
        });

        // 2. Calcula os pontos de todas as apostas para este jogo
	const sqlCalculo = `
				UPDATE dApostas 
				SET Res1 = ?, 
					Res2 = ?, 
					Pontos = CASE 
						-- Se não houve palpite, 0 pontos
						WHEN Ap1 IS NULL OR Ap2 IS NULL THEN 0

						-- 1. Placar Exato (25 pts)
						WHEN Ap1 = ? AND Ap2 = ? THEN 25

						-- 2. Acertou apenas a tendência / resultado (10 pts)
						WHEN (Ap1 > Ap2 AND ? > ?) OR 
							 (Ap1 < Ap2 AND ? < ?) OR 
							 (Ap1 = Ap2 AND ? = ?) THEN 10

						-- 3. Nenhum acerto
						ELSE 0 
					END
				WHERE Jogo = ?
			`;

			await db.execute({
				sql: sqlCalculo,
				args: [
					r1, r2,         // SET Res1, Res2
					r1, r2,         // Placar Exato (25 pts)
					r1, r2,         // Caso: A ganhou (10 pts)
					r1, r2,         // Caso: B ganhou (10 pts)
					r1, r2,         // Caso: Empate (10 pts)
					jogo            // WHERE Jogo
				]
			});

        res.json({ success: true, message: "Resultado atualizado e pontos recalculados com a nova lógica!" });
    } catch (e) {
        console.error("Erro ao calcular pontos:", e);
        res.status(500).json({ success: false });
    }
});

// --- RANKING GERAL COM STATUS ONLINE ---
app.get('/api/ranking', async (req, res) => {
    try {
        // Busca pontos e verifica se o último ping (InOut) foi nos último minuto
        const result = await db.execute(`
            SELECT 
                l.Apelido, 
				l.PG,
                SUM(IFNULL(a.Pontos, 0)) as TotalPontos,
                CASE 
                    WHEN l.InOut > datetime('now', '-1 minutes', 'localtime') THEN 1 
                    ELSE 0 
                END as Online
            FROM dLogin l
            LEFT JOIN dApostas a ON l.Apelido = a.Apelido
            GROUP BY l.Apelido, l.PG
            ORDER BY TotalPontos DESC, l.Apelido ASC
        `);
        res.json({ success: true, ranking: result.rows });
    } catch (e) {
        console.error("Erro ao buscar ranking:", e);
        res.status(500).json({ success: false });
    }
});

/// Rota otimizada para buscar os palpites da galera filtrados direto no banco
// Substitua a sua rota antiga por esta no seu server.js
app.get('/api/palpites-galera', async (req, res) => {
    const { jogo, apelido } = req.query;

    try {
        let query = "SELECT * FROM dApostas";
        const args = [];
        const condicoes = [];

        // 1. Se o usuário escolheu um apostador específico
        if (apelido) {
            condicoes.push("UPPER(Apelido) = ?");
            args.push(apelido.toUpperCase());
        }

        // 2. Se o usuário escolheu um jogo específico
        if (jogo) {
            condicoes.push("Jogo = ?");
            args.push(jogo);
        }

        // 3. CARGA INICIAL (Sem filtros): Busca automaticamente o jogo correto usando a Opção 2
        if (!jogo && !apelido) {
            // Captura a data atual exata no fuso horário de Brasília (Formato: AAAA-MM-DD)
            const dataAtualStr = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date()).split('/').reverse().join('-');

            // Captura a hora atual exata no fuso horário de Brasília (Formato: HH:MM)
            const horaAtualStr = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                hour: '2-digit', minute: '2-digit', hour12: false
            }).format(new Date());

            // Busca o jogo mais recente cuja Data e Horário sejam menores ou iguais ao exato momento de agora
            const ultimoJogoResult = await db.execute({
                sql: `SELECT Jogo FROM dTabela 
                      WHERE Data < ? OR (Data = ? AND Horario <= ?) 
                      ORDER BY Data DESC, Horario DESC LIMIT 1`,
                args: [dataAtualStr, dataAtualStr, horaAtualStr]
            });
            
            let jogoPadrao = "";
            if (ultimoJogoResult.rows.length > 0) {
                jogoPadrao = ultimoJogoResult.rows[0].Jogo;
            } else {
                // Se nenhum jogo começou ainda, traz o primeiríssimo jogo do campeonato
                const primeiroJogoResult = await db.execute("SELECT Jogo FROM dTabela ORDER BY Data ASC, Horario ASC LIMIT 1");
                if (primeiroJogoResult.rows.length > 0) jogoPadrao = primeiroJogoResult.rows[0].Jogo;
            }

            if (jogoPadrao) {
                condicoes.push("Jogo = ?");
                args.push(jogoPadrao);
            }
        }

        // Monta a cláusula WHERE dinamicamente se houver filtros
        if (condicoes.length > 0) {
            query += " WHERE " + condicoes.join(" AND ");
        }

        // Mantém a ordenação rápida
        query += " ORDER BY Jogo ASC, Apelido ASC";
        
        const result = await db.execute({ sql: query, args: args }); 

        const palpites = result.rows.map(row => ({
            Apelido: row.Apelido,
            Jogo: row.Jogo,
            Sel1: row.Sel1,
            Ap1: row.Ap1,
            Sel2: row.Sel2,
            Ap2: row.Ap2,
            Res1: row.Res1,
            Res2: row.Res2,
            Pontos: row.Pontos,
            Data: row.Data,
            Horario: row.Horario
        }));

        // Puxa as listas auxiliares para alimentar os selects da tela
        const jogosTabela = await db.execute("SELECT Jogo, Sel1, Sel2 FROM dTabela ORDER BY Data ASC, Horario ASC");
        const apostadoresTabela = await db.execute("SELECT DISTINCT Apelido FROM dLogin ORDER BY Apelido ASC");

        res.json({ 
            success: true, 
            palpites: palpites,
            listaJogos: jogosTabela.rows, 
            listaApostadores: apostadoresTabela.rows,
            jogoInicial: jogo ? jogo : (args[0] || "")
        });

    } catch (error) {
        console.error("Erro ao buscar palpites da galera:", error);
        res.status(500).json({ success: false, message: "Erro interno no servidor" });
    }
});
// --- API DE ESTATÍSTICAS E GRÁFICOS ---

// 1. Rota para o Ranking Geral (Por Apelido)
app.get('/api/estatisticas/geral', async (req, res) => {
    try {
        // Seleciona o apelido e a soma de pontos de cada aposta acertada
        const query = `
            SELECT l.Apelido, SUM(a.Pontos) as TotalPontos
            FROM dLogin l
            JOIN dApostas a ON l.Apelido = a.Apelido
            GROUP BY l.Apelido
            ORDER BY TotalPontos DESC
        `;
        const result = await db.execute(query);
        res.json({ success: true, dados: result.rows });
    } catch (error) {
        console.error("Erro ao buscar estatísticas gerais:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Rota para o Ranking por Gerência
app.get('/api/estatisticas/gerencia', async (req, res) => {
    const tipo = req.query.tipo || 'SOMA'; // SOMA ou MEDIA
    try {
        let metricsSQL = "SUM(a.Pontos)";
        if (tipo === 'MEDIA') {
            metricsSQL = "ROUND(AVG(user_total.Total), 1)";
        }

        // Para média harmônica por participante, primeiro somamos por usuário, depois agrupamos por gerência
        const query = tipo === 'MEDIA' ? `
            SELECT Gerencia, ROUND(AVG(TotalUser), 1) as TotalPontos
            FROM (
                SELECT l.Gerencia, l.Apelido, SUM(a.Pontos) as TotalUser
                FROM dLogin l
                JOIN dApostas a ON l.Apelido = a.Apelido
                GROUP BY l.Apelido
            )
            WHERE Gerencia IS NOT NULL AND Gerencia != ''
            GROUP BY Gerencia
            ORDER BY TotalPontos DESC
        ` : `
            SELECT l.Gerencia, SUM(a.Pontos) as TotalPontos
            FROM dLogin l
            JOIN dApostas a ON l.Apelido = a.Apelido
            WHERE l.Gerencia IS NOT NULL AND l.Gerencia != ''
            GROUP BY l.Gerencia
            ORDER BY TotalPontos DESC
        `;

        const result = await db.execute(query);
        res.json({ success: true, dados: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Rota para o Ranking por Times (Equipes)
app.get('/api/estatisticas/times', async (req, res) => {
    const tipo = req.query.tipo || 'SOMA'; // SOMA ou MEDIA
    try {
        const query = tipo === 'MEDIA' ? `
            SELECT Time, ROUND(AVG(TotalUser), 1) as TotalPontos
            FROM (
                SELECT l.Time, l.Apelido, SUM(a.Pontos) as TotalUser
                FROM dLogin l
                JOIN dApostas a ON l.Apelido = a.Apelido
                GROUP BY l.Apelido
            )
            WHERE Time IS NOT NULL AND Time != ''
            GROUP BY Time
            ORDER BY TotalPontos DESC
        ` : `
            SELECT l.Time, SUM(a.Pontos) as TotalPontos
            FROM dLogin l
            JOIN dApostas a ON l.Apelido = a.Apelido
            WHERE l.Time IS NOT NULL AND l.Time != ''
            GROUP BY l.Time
            ORDER BY TotalPontos DESC
        `;

        const result = await db.execute(query);
        res.json({ success: true, dados: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- ROTA: ENVIAR RANKING SIMPLIFICADO ---
app.post('/enviar-ranking', async (req, res) => {
    const { destinatario } = req.body;

    try {
        // Busca dados do ranking
        const result = await db.execute(`
            SELECT 
                l.Apelido, 
                SUM(IFNULL(a.Pontos, 0)) as TotalPontos
            FROM dLogin l
            LEFT JOIN dApostas a ON l.Apelido = a.Apelido
            GROUP BY l.Apelido
            ORDER BY TotalPontos DESC, l.Apelido ASC
        `);

        let linhasTabela = '';
        result.rows.forEach((user, index) => {
            linhasTabela += `
                <tr>
                    <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center; color: #888;">${index + 1}º</td>
                    <td style="padding: 12px; border-bottom: 1px solid #333; font-weight: bold; color: #fff;">${user.Apelido}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #333; text-align: center; color: #4CAF50; font-weight: bold;">${user.TotalPontos}</td>
                </tr>`;
        });

	const corpoHtml = `
            <div style="background-color: #000000; color: #ffffff; padding: 30px; font-family: Arial, sans-serif;">
                <div style="max-width: 500px; margin: auto; background-color: #121212; border: 2px solid #4CAF50; border-radius: 12px; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 25px;">
                        <h1 style="color: #4CAF50; margin: 0;">🏆 RANKING GERAL</h1>
                        <p style="font-size: 14px; color: #888;">Bolão da NAZ 2026</p>
                    </div>
                    
                    <table style="width: 100%; border-collapse: collapse; color: #ffffff;">
                        <thead>
                            <tr style="background-color: #1a1a1a;">
                                <th style="padding: 12px; border-bottom: 2px solid #4CAF50; color: #4CAF50;">Pos</th>
                                <th style="padding: 12px; border-bottom: 2px solid #4CAF50; text-align: left; color: #4CAF50;">Nome</th>
                                <th style="padding: 12px; border-bottom: 2px solid #4CAF50; color: #4CAF50;">Pts</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${linhasTabela}
                        </tbody>
                    </table>
                    
                    <div style="text-align: center; margin-top: 30px; font-size: 11px; color: #555;">
                        <p>E-mail automático enviado pelo Bolão da NAZ</p>
                    </div>
                </div>
            </div>
        `;

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: `"Bolão 2026" <${process.env.EMAIL_USER}>`,
            to: destinatario,
            subject: '📊 Classificação Atualizada - Bolão 2026',
            html: corpoHtml
        });

        res.send('<h1>Ranking enviado com sucesso!</h1><a href="/mailv2.html">Voltar</a>');

    } catch (error) {
        console.error("Erro no envio do ranking:", error);
        res.status(500).send('Erro ao processar e-mail: ' + error.message);
    }

});

// No server.js, adicione isto:
app.post('/api/logout', async (req, res) => {
    const { apelido } = req.body;
    try {
        await db.execute({
            sql: "UPDATE dLogin SET InOut = '2000-01-01 00:00:00' WHERE Apelido = ?",
            args: [apelido]
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
