require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  firstCryFtk: process.env.FIRSTCRY_FTK,
  firstCryCookie: process.env.FIRSTCRY_COOKIE,
  pincode: Number(process.env.FIRSTCRY_PINCODE || 411027),

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  minDelay: Number(process.env.MIN_DELAY_SECONDS || 30),
  maxDelay: Number(process.env.MAX_DELAY_SECONDS || 120),
};

const FIRSTCRY_API_URL = 'https://www.firstcry.com/api/shortlist';

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'stock-history.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Validate configuration
function validateConfig() {
  const required = [
    ['FIRSTCRY_FTK', CONFIG.firstCryFtk],
    ['FIRSTCRY_COOKIE', CONFIG.firstCryCookie],
    ['TELEGRAM_BOT_TOKEN', CONFIG.telegramBotToken],
    ['TELEGRAM_CHAT_ID', CONFIG.telegramChatId],
  ];

  for (const [key, value] of required) {
    if (!value) {
      throw new Error(`Missing environment variable: ${key}`);
    }
  }

  if (!Number.isInteger(CONFIG.pincode) || CONFIG.pincode <= 0) {
    throw new Error('Invalid FIRSTCRY_PINCODE');
  }

  if (!Number.isInteger(CONFIG.minDelay) || !Number.isInteger(CONFIG.maxDelay) || CONFIG.minDelay < 0 || CONFIG.maxDelay < CONFIG.minDelay) {
    throw new Error('Invalid polling delay configuration');
  }
}

// Create data directory
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load previous stock history
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Unable to load stock history:', error.message);
  }

  return {};
}

// Save stock history
function saveHistory(history) {
  const tempFile = `${HISTORY_FILE}.tmp`;

  fs.writeFileSync(tempFile, JSON.stringify(history, null, 2));
  fs.renameSync(tempFile, HISTORY_FILE);
}

// Generate polling delay
function getRandomDelay() {
  return Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1) + CONFIG.minDelay);
}

// Generate FirstCry product URL
function getProductUrl(product) {
  // Prefer a URL returned by the API
  if (typeof product.url === 'string' && product.url.startsWith('https://www.firstcry.com/')) {
    return product.url;
  }

  // Fallback: construct URL using product name and ID
  const slug = (product.name || 'hot-wheels')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `https://www.firstcry.com/hot-wheels/${slug}/${product.id}/product-detail`;
}

// Send Telegram notification
async function sendTelegramMessage(message, productUrl = null) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;

  const payload = {
    chat_id: CONFIG.telegramChatId,
    text: message,
    disable_web_page_preview: true,
  };

  // Add clickable product button
  if (productUrl) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: 'View Product',
            url: productUrl,
          },
        ],
      ],
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram HTTP ${response.status}`);
  }

  return result;
}

// Fetch FirstCry shortlist
async function fetchShortlist() {
  const response = await fetch(FIRSTCRY_API_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.firstcry.com',
      Referer: 'https://www.firstcry.com/myshortlist',
      Cookie: CONFIG.firstCryCookie,
    },
    body: JSON.stringify({
      ftk: CONFIG.firstCryFtk,
      boostProductIds: '',
      type: 'shortlist',
      isclub: '0',
      pcode: CONFIG.pincode,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const error = new Error(`FirstCry API returned HTTP ${response.status}`);

    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.products)) {
    throw new Error('Invalid FirstCry API response: products missing');
  }

  return data.products;
}

// Determine stock status
function getStockStatus(product) {
  const stock = product.stock?.current;

  if (stock === null || stock === undefined || (typeof stock === 'string' && stock.trim() === '') || !Number.isFinite(Number(stock))) {
    return {
      status: 'UNKNOWN',
      quantity: null,
    };
  }

  const quantity = Number(stock);

  if (quantity > 0) {
    return {
      status: 'IN_STOCK',
      quantity,
    };
  }

  if (quantity === 0) {
    return {
      status: 'OUT_OF_STOCK',
      quantity: 0,
    };
  }

  return {
    status: 'UNKNOWN',
    quantity: null,
  };
}

// Build Telegram notification
function buildStockMessage(product, quantity) {
  return ['🔥 HOT WHEELS STOCK ALERT', '', `Product: ${product.name || 'Unknown product'}`, `Available quantity: ${quantity}`, `Product ID: ${product.id}`, '', 'Status: IN STOCK'].join('\n');
}

// Process products and notify when stock becomes available
async function processProducts(products, history) {
  const checkedAt = new Date().toISOString();

  for (const product of products) {
    if (product.id === undefined || product.id === null) {
      console.error('Skipping product without an ID');
      continue;
    }

    const productId = String(product.id);
    const productName = product.name || 'Unknown product';

    const { status, quantity } = getStockStatus(product);
    const previous = history[productId];

    console.log(`[${status}] ${productName} | Quantity: ${quantity ?? 'Unknown'}`);

    if (status === 'UNKNOWN') {
      continue;
    }

    const becameAvailable = status === 'IN_STOCK' && (!previous || previous.status !== 'IN_STOCK');

    // Send notification when product becomes available
    if (becameAvailable) {
      try {
        const message = buildStockMessage(product, quantity);
        const productUrl = getProductUrl(product);

        await sendTelegramMessage(message, productUrl);

        console.log(`Telegram notification sent: ${productName}`);
      } catch (error) {
        console.error(`Telegram notification failed for ${productName}:`, error.message);

        // Leave previous status unchanged so notification can retry
        continue;
      }
    }

    // Update stock history
    history[productId] = {
      name: productName,
      status,
      quantity,
      lastChecked: checkedAt,
    };
  }

  saveHistory(history);
}

// Main stock checker
async function main() {
  validateConfig();

  const history = loadHistory();

  console.log('==================================');
  console.log('       FIRSTCRY STOCK CHECKER');
  console.log('==================================');
  console.log(`Pincode: ${CONFIG.pincode}`);
  console.log(`Polling interval: ${CONFIG.minDelay}-${CONFIG.maxDelay} seconds`);
  console.log('Telegram notifications: Enabled');

  // Send startup notification
  try {
    await sendTelegramMessage('FirstCry Stock Checker started successfully.');

    console.log('Telegram connection successful.');
  } catch (error) {
    console.error('Telegram startup notification failed:', error.message);
    throw error;
  }

  while (true) {
    console.log('\n========== NEW STOCK CHECK ==========');
    console.log('Time:', new Date().toLocaleString());

    try {
      const products = await fetchShortlist();

      console.log(`Products received: ${products.length}`);

      await processProducts(products, history);
    } catch (error) {
      console.error('Stock check failed:', error.message);

      if ([401, 403].includes(error.statusCode)) {
        console.error('FirstCry authentication failed. Refresh your session credentials.');
        break;
      }

      if (error.statusCode === 429) {
        console.error('FirstCry rate limit reached. Stopping further requests.');
        break;
      }
    }

    const delay = getRandomDelay();

    console.log(`Next check in ${delay} seconds.`);

    await sleep(delay * 1000);
  }

  console.log('Stock checker stopped.');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nStock checker stopped by user.');
  process.exit(0);
});

main().catch((error) => {
  console.error('Application error:', error.message);
  process.exit(1);
});
