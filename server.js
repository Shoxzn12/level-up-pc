import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import axios from "axios";
import { MercadoPagoConfig, Preference } from "mercadopago";

// Cargar variables de entorno
dotenv.config();
console.log("API KEY LEÍDA POR EL SERVIDOR:", process.env.OPENAI_API_KEY);

// Obtener ruta absoluta
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

// Middleware
app.use(cors());
app.use(express.json());

// Servir archivos estáticos (tu web)
app.use(express.static(path.join(__dirname, "dist")));

// ==========================
// PRODUCTOS: DATASTORE JSON
// ==========================
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "products-store.json");

function ensureDataStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STORE_FILE)) {
      // Intentar seed desde src/data/products_fixed.json o products.json
      const candidates = [
        path.join(__dirname, "src", "data", "products_fixed.json"),
        path.join(__dirname, "src", "data", "products.json"),
      ];
      let seed = { products: [], brands: [] };
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            const raw = JSON.parse(fs.readFileSync(p, "utf8"));
            // Normalizar: asegurar estructura y agregar stock=0 si falta
            const products = (raw.products || []).map((it) => ({
              id: Number(it.id),
              name: String(it.name || "Producto"),
              price: Number(it.price || 0),
              category: String(it.category || ""),
              brand: String(it.brand || ""),
              image: String(it.image || ""),
              stock: Number(it.stock || 0),
            }));
            const brands = Array.isArray(raw.brands) ? raw.brands : [];
            seed = { products, brands };
            break;
          } catch {}
        }
      }
      fs.writeFileSync(STORE_FILE, JSON.stringify(seed, null, 2));
      console.log("🗃️ Datastore creado y sembrado desde JSON inicial:", STORE_FILE);
    }
  } catch (err) {
    console.error("❌ Error asegurando datastore:", err);
  }
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Error leyendo datastore:", err);
    return { products: [], brands: [] };
  }
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    return true;
  } catch (err) {
    console.error("❌ Error guardando datastore:", err);
    return false;
  }
}

ensureDataStore();

// ==========================
// MIDDLEWARE ADMIN
// ==========================
function requireAdmin(req, res, next) {
  // Chequear Bearer token o query admin_token
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const q = (req.query.admin_token || "").toString();
  const provided = bearer || q;
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: "ADMIN_TOKEN no configurado en el servidor" });
  }
  if (provided !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// ==========================
// ENDPOINTS PRODUCTOS
// ==========================
app.get("/api/products", (req, res) => {
  const store = loadStore();
  res.json({ products: store.products, brands: store.brands || [] });
});

app.get("/api/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const store = loadStore();
  const p = store.products.find((x) => Number(x.id) === id);
  if (!p) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(p);
});

// Crear producto (admin)
app.post("/api/products", requireAdmin, (req, res) => {
  const { name, price, category, brand, image, stock, id } = req.body || {};
  if (!name || price == null) {
    return res.status(400).json({ error: "Faltan campos obligatorios (name, price)." });
  }
  const store = loadStore();
  const newId = id != null ? Number(id) : (store.products.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1);
  if (store.products.some((x) => Number(x.id) === newId)) {
    return res.status(409).json({ error: "ID ya existe" });
  }
  const product = {
    id: newId,
    name: String(name),
    price: Number(price),
    category: String(category || ""),
    brand: String(brand || ""),
    image: String(image || ""),
    stock: Number(stock || 0),
  };
  store.products.push(product);
  saveStore(store);
  res.status(201).json(product);
});

// Actualizar stock (admin)
app.patch("/api/products/:id/stock", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { stock } = req.body || {};
  if (stock == null || Number.isNaN(Number(stock)) || Number(stock) < 0) {
    return res.status(400).json({ error: "Stock inválido" });
  }
  const store = loadStore();
  const p = store.products.find((x) => Number(x.id) === id);
  if (!p) return res.status(404).json({ error: "Producto no encontrado" });
  p.stock = Number(stock);
  saveStore(store);
  res.json({ id: p.id, stock: p.stock });
});

// Eliminar producto (admin)
app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const store = loadStore();
  const idx = store.products.findIndex((x) => Number(x.id) === id);
  if (idx === -1) return res.status(404).json({ error: "Producto no encontrado" });
  const [removed] = store.products.splice(idx, 1);
  saveStore(store);
  res.json({ removed });
});

// Cliente OpenAI (nuevo SDK)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==========================
// CONFIGURACIÓN MERCADO PAGO
// ==========================
const clientMP = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, // se toma desde .env
});

if (!process.env.MERCADOPAGO_ACCESS_TOKEN) {
  console.error("❌ No se configuró MERCADOPAGO_ACCESS_TOKEN en el archivo .env");
} else {
  console.log("✅ Mercado Pago configurado correctamente");
}

// ==========================
// ENDPOINT CHAT OPENAI
// ==========================
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Falta el campo 'message'." });
    }

    // Si no existe clave → usar fallback
    if (!process.env.OPENAI_API_KEY) {
      console.log("⚠️ No hay API KEY → Respondiendo desde fallback");
      return res.json({ reply: getFallbackResponse(message) });
    }

    // Llamada real a la API de OpenAI
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Rápido y barato
      messages: [
        { role: "system", content: "Eres el asistente virtual de Level Up PC." },
        { role: "user", content: message },
      ],
    });

    return res.json({ reply: response.choices[0].message.content });

  } catch (error) {
    console.error("❌ Error con la API:", error);
    return res.json({ reply: getFallbackResponse(req.body.message) });
  }
});

// ==========================
// RESPUESTAS FALLBACK CHAT
// ==========================
function getFallbackResponse(message) {
  const msg = message.toLowerCase();

  if (msg.includes("precio")) return "Puedes ver los precios actualizados en la sección 'Lista de Precios'.";
  if (msg.includes("procesador")) return "Tenemos procesadores Intel y AMD de última generación. ¿Para gaming o trabajo?";
  if (msg.includes("gpu") || msg.includes("gráfica")) return "Contamos con tarjetas NVIDIA y AMD. ¿Qué presupuesto manejas?";

  return "Hola 👋 Soy el asistente de Level Up PC. ¿Qué componente estás buscando hoy?";
}

// ==========================
// ENDPOINT CREAR PREFERENCIA MP
// ==========================
app.post("/api/create_preference", async (req, res) => {
  try {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
    if (!token) {
      return res.status(400).json({ error: "MERCADOPAGO_ACCESS_TOKEN no configurado" });
    }
    // En desarrollo, usar token de PRUEBA (TEST-APP_USR-...)
    if ((process.env.NODE_ENV || "development") !== "production" && token.startsWith("APP_USR-")) {
      return res.status(400).json({
        error: "Token de producción detectado en entorno de pruebas",
        code: "USE_TEST_ACCESS_TOKEN",
        hint: "Usa el Access Token de pruebas del Seller (TEST-APP_USR-...)",
      });
    }
    const { title, price, quantity, items, payerEmail } = req.body;

    if (!title || !price || !quantity) {
      return res.status(400).json({ error: "Faltan campos en la solicitud." });
    }

    const preference = new Preference(clientMP);

    // Construir items de la preferencia: lista completa o único total
    const mpItems = Array.isArray(items) && items.length > 0
      ? items.map((it) => ({
          title: String(it.title || "Item"),
          unit_price: Number(it.price || 0),
          quantity: Number(it.quantity || 1),
        }))
      : [
          {
            title: String(title || "Compra Level Up PC"),
            unit_price: Number(price),
            quantity: Number(quantity || 1),
          },
        ];

    const baseUrl = (process.env.WEBSITE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

    const payload = {
      body: {
        items: mpItems,
        payer: payerEmail ? { email: String(payerEmail) } : undefined,
        statement_descriptor: "LEVELUPPC",
        external_reference: `ORDER-${Date.now()}`,
        back_urls: {
          success: `${baseUrl}/success.html`,
          failure: `${baseUrl}/failure.html`,
          pending: `${baseUrl}/pending.html`,
        },
        // auto_return: "approved", // Removido para evitar validación cuando falta back_urls.success según políticas
      },
    };

    if (process.env.DEBUG_MP === "1") {
      console.log("📦 Payload preferencia MP:", JSON.stringify(payload, null, 2));
    }

    const result = await preference.create(payload);

    // Compatibilidad con diferentes versiones del SDK
    const initPoint = (result && (result.init_point || (result.body && result.body.init_point))) || null;
    if (!initPoint) {
      console.error("⚠️ Preferencia creada pero sin init_point esperado:", result);
      return res.status(500).json({ error: "Preferencia creada sin init_point" });
    }
    res.json({ init_point: initPoint });
  } catch (error) {
    // Mostrar información detallada del error
    const status = (error && (error.status || (error.cause && error.cause.status))) || 500;
    const message = (error && (error.message || (error.cause && error.cause.message))) || "Error creando la preferencia de pago";
    console.error("❌ Error creando preferencia:", error);
    res.status(status).json({ error: message, details: error });
  }
});

// ==========================
// DIAGNÓSTICO MP: USERS/ME
// ==========================
app.get("/api/mp_whoami", async (req, res) => {
  try {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
    if (!token) {
      return res.status(400).json({ error: "MERCADOPAGO_ACCESS_TOKEN no configurado" });
    }
    const masked = `${token.slice(0, 10)}...${token.slice(-6)}`;
    console.log(`🔍 Consultando users/me con token: ${masked}`);
    const r = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || "Error consultando users/me", status: r.status });
    }
    const info = {
      id: data?.id,
      nickname: data?.nickname,
      email: data?.email,
      site_id: data?.site_id, // MCO (Colombia), MLA (Argentina), etc.
      default_currency_id: data?.default_currency_id,
      status: data?.status,
    };
    res.json(info);
  } catch (err) {
    console.error("❌ Error en mp_whoami:", err);
    res.status(500).json({ error: "Fallo al consultar users/me" });
  }
});

// ==========================
// RUTA PRINCIPAL
// ==========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ==========================
// INICIO DEL SERVIDOR
// ==========================
app.listen(PORT, () => {
  console.log(`✅ Servidor funcionando en http://localhost:${PORT}`);
  console.log(`💬 Chat listo en http://localhost:${PORT}/api/chat`);
  console.log(`💳 Mercado Pago listo en http://localhost:${PORT}/api/create_preference`);
});
