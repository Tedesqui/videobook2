require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { TextractClient, DetectDocumentTextCommand } = require("@aws-sdk/client-textract");

// --- CONFIGURAÇÃO DO SERVIDOR ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE CORS ---
// IMPORTANTE: Substitua pela URL real do seu frontend na GitHub Pages.
const GITHUB_PAGES_URL = 'https://tedesqui.github.io/videobook2/'; 
app.use(cors({
  origin: GITHUB_PAGES_URL
}));

// Permite que o servidor entenda JSON e aumenta o limite do payload para imagens
app.use(express.json({ limit: '10mb' }));


// --- ROTA DE OCR (AWS TEXTRACT) ---
// Endpoint para receber uma imagem e retornar o texto extraído.
app.post('/api/ocr-aws', async (req, res) => {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
        return res.status(400).json({ error: "Nenhuma imagem fornecida." });
    }

    try {
        const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        const client = new TextractClient({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
        const command = new DetectDocumentTextCommand({ Document: { Bytes: buffer } });
        const data = await client.send(command);
        const extractedText = data.Blocks?.filter(block => block.BlockType === 'LINE').map(block => block.Text).join(' ') || '';
        
        res.json({ text: extractedText });

    } catch (error) {
        console.error("Erro no OCR da AWS:", error);
        res.status(500).json({ error: "Falha ao processar a imagem com AWS Textract." });
    }
});


// --- ROTA DE GERAÇÃO DE VÍDEO (FAL.AI) ---
// Endpoint para receber um texto (prompt) e retornar um vídeo gerado.
app.post('/api/gerar-video-fal', async (req, res) => {
    const { prompt, seed } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: "O texto (prompt) é obrigatório." });
    }

    const FAL_MODEL_URL = 'https://fal.run/fal-ai/wan-2-2';
    const payload = {
        prompt: prompt,
        image_size: "square_hd",
        ...(seed && { seed: Number(seed) }) 
    };

    try {
        // Lê as duas variáveis de ambiente do Fal.ai separadamente
        const keyId = process.env.FAL_AI_KEY_ID;
        const keySecret = process.env.FAL_AI_KEY_SECRET;

        // Validação para garantir que as chaves foram configuradas no servidor
        if (!keyId || !keySecret) {
            throw new Error("Credenciais do Fal.ai (KEY_ID ou KEY_SECRET) não estão configuradas no servidor.");
        }

        // Constrói o cabeçalho de autorização no formato exigido pela API do Fal.ai
        const authHeader = `Key ${keyId}:${keySecret}`;

        const response = await axios.post(FAL_MODEL_URL, payload, {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
            }
        });

        const videoURL = response.data?.videos?.[0]?.url;
        const newSeed = response.data?.seed;

        if (!videoURL) {
            throw new Error("URL do vídeo não encontrada na resposta da API do Fal.ai.");
        }
        
        res.json({ videoURL, seed: newSeed });

    } catch (error) {
        console.error("Erro na API do Fal.ai:", error.message);
        res.status(500).json({ error: "Falha ao gerar o vídeo com Fal.ai." });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor iniciado e rodando na porta ${PORT}`);
});
