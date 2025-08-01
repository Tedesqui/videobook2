// server.js Atualizado para o novo modelo de pagamento

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_PAGES_URL = 'https://SEU_USUARIO.github.io/SEU_REPOSITORIO_FRONTEND';

// --- MIDDLEWARE ---
app.use(cors({ origin: GITHUB_PAGES_URL }));
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), handleStripeWebhook);
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL + "?sslmode=require",
});

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  algorithms: ['RS256']
});

// --- FUNÇÕES AUXILIARES ---
const findOrCreateUser = async (auth0Id, email) => {    
    let user = await pool.query("SELECT * FROM users WHERE auth0_id = $1", [auth0Id]);
    if (user.rows.length === 0) {
        user = await pool.query(
            "INSERT INTO users (auth0_id, email) VALUES ($1, $2) RETURNING *",
            [auth0Id, email]
        );
    }
    return user.rows[0];
};

// --- ROTAS DA API ---

app.get('/api/get-user-status', checkJwt, async (req, res) => {
    try {
        const auth0Id = req.auth.sub;
        const userEmail = req.auth.email || 'email-not-provided';
        const user = await findOrCreateUser(auth0Id, userEmail);
        res.json({ credits: user.credits, email: user.email });
    } catch (error) {
        console.error("Erro ao buscar status do usuário:", error);
        res.status(500).json({ error: "Erro interno do servidor." });
    }
});

// ALTERAÇÃO: Rota para criar checkout agora recebe a quantidade de créditos
app.post('/api/create-checkout-session', checkJwt, async (req, res) => {
    const auth0Id = req.auth.sub;
    const { priceId, creditsAmount } = req.body; // Recebe o ID do preço e a quantidade de créditos

    if (!priceId || !creditsAmount) {
        return res.status(400).json({ error: "Price ID e a quantidade de créditos são necessários." });
    }

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card', 'boleto'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${GITHUB_PAGES_URL}?payment=success`,
        cancel_url: `${GITHUB_PAGES_URL}?payment=cancel`,
        // ALTERAÇÃO: Passa a quantidade de créditos na metadata
        metadata: { 
            auth0_id: auth0Id,
            credits_to_add: creditsAmount 
        }
    });

    res.json({ id: session.id });
});

app.post('/api/gerar-video-fal', checkJwt, async (req, res) => {
    // ... (Esta rota não muda, a lógica de verificar e descontar 1 crédito já está correta)
    const auth0Id = req.auth.sub;
    const userResult = await pool.query("SELECT * FROM users WHERE auth0_id = $1", [auth0Id]);
    const user = userResult.rows[0];

    if (!user || user.credits <= 0) {
        return res.status(402).json({ error: "Créditos insuficientes. Por favor, compre mais créditos." });
    }
    try {
        const { prompt, seed } = req.body;
        const FAL_MODEL_URL = 'https://fal.run/fal-ai/wan/v2.2-5b/text-to-video';
        const payload = { prompt, image_size: "square_hd", ...(seed && { seed: Number(seed) }) };
        const keyId = process.env.FAL_AI_KEY_ID;
        const keySecret = process.env.FAL_AI_KEY_SECRET;
        if (!keyId || !keySecret) throw new Error("Credenciais do Fal.ai não estão configuradas no servidor.");
        const authHeader = `Key ${keyId}:${keySecret}`;
        const response = await axios.post(FAL_MODEL_URL, payload, { headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }});
        const videoURL = response.data?.videos?.[0]?.url;
        const newSeed = response.data?.seed;
        if (!videoURL) throw new Error("URL do vídeo não encontrada na resposta da API.");
        
        await pool.query("UPDATE users SET credits = credits - 1 WHERE auth0_id = $1", [auth0Id]);
        res.json({ videoURL, seed: newSeed, remainingCredits: user.credits - 1 });
    } catch (apiError) {
        console.error("Erro na API da Fal.ai:", apiError);
        res.status(500).json({ error: "Falha ao gerar o vídeo." });
    }
});

// ALTERAÇÃO: Webhook agora lê a quantidade de créditos da metadata
async function handleStripeWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const auth0Id = session.metadata.auth0_id;
        // Lê dinamicamente a quantidade de créditos a adicionar
        const creditsToAdd = parseInt(session.metadata.credits_to_add, 10);

        if (auth0Id && creditsToAdd > 0) {
            await pool.query(
                "UPDATE users SET credits = credits + $1 WHERE auth0_id = $2",
                [creditsToAdd, auth0Id]
            );
            console.log(`${creditsToAdd} créditos adicionados para o usuário ${auth0Id}`);
        }
    }

    res.json({received: true});
}

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
