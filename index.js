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

  maxErrors: 5,
};

const FIRSTCRY_API_URL = 'https://www.firstcry.com/api/shortlist';

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'stock-history.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Global error tracking
let errorCount = 0;
let isStopping = false;

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
    throw new Error(`Stock history loading failed: ${error.message}`);
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

// Report errors to Telegram
async function reportError(error, context) {
  errorCount++;

  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error('\n========== APPLICATION ERROR ==========');
  console.error('Context:', context);
  console.error('Error:', errorMessage);
  console.error(`Error count: ${errorCount}/${CONFIG.maxErrors}`);

  const notification = ['FIRSTCRY STOCK CHECKER ERROR', '', `Context: ${context}`, `Error: ${errorMessage}`, '', `Consecutive errors: ${errorCount}/${CONFIG.maxErrors}`, `Time: ${new Date().toLocaleString()}`].join('\n');

  // Try to notify Telegram.
  // Do not recursively count Telegram notification failures.
  try {
    await sendTelegramMessage(notification);
    console.log('Error notification sent to Telegram.');
  } catch (telegramError) {
    console.error('Could not send error notification:', telegramError.message);
  }

  // Stop after reaching the error limit
  if (errorCount >= CONFIG.maxErrors) {
    console.error('\nMaximum error limit reached.');

    await stopApplication(`Application stopped after ${CONFIG.maxErrors} consecutive errors.`);

    return true;
  }

  return false;
}

// Stop application
async function stopApplication(reason) {
  if (isStopping) return;

  isStopping = true;

  console.error('\n==================================');
  console.error('       APPLICATION STOPPING');
  console.error('==================================');
  console.error(reason);

  try {
    await sendTelegramMessage(['FIRSTCRY STOCK CHECKER STOPPED', '', reason, '', `Total consecutive errors: ${errorCount}`, `Time: ${new Date().toLocaleString()}`].join('\n'));

    console.log('Shutdown notification sent to Telegram.');
  } catch (error) {
    console.error('Unable to send shutdown notification:', error.message);
  }

  process.exit(1);
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

// Build stock notification
function buildStockMessage(product, quantity) {
  return ['HOT WHEELS STOCK ALERT', '', `Product: ${product.name || 'Unknown product'}`, `Available quantity: ${quantity}`, `Product ID: ${product.id}`, '', 'Status: IN STOCK'].join('\n');
}

// Process products
async function processProducts(products, history) {
  const checkedAt = new Date().toISOString();

  for (const product of products) {
    if (product.id === undefined || product.id === null) {
      throw new Error('Received a product without an ID');
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

    // Notify when product becomes available
    if (becameAvailable) {
      const message = buildStockMessage(product, quantity);
      const productUrl = getProductUrl(product);

      for (let i = 1; i <= 3; i++) {
        try {
          await sendTelegramMessage(`${message}\n\nNotification: ${i}/3`, productUrl);

          console.log(`Telegram notification ${i}/3 sent: ${productName}`);

          // Small gap between notifications
          if (i < 3) {
            await sleep(2000);
          }
        } catch (error) {
          console.error(`Telegram notification ${i}/3 failed for ${productName}:`, error.message);

          throw error;
        }
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
  console.log(`Maximum consecutive errors: ${CONFIG.maxErrors}`);
  console.log('Telegram notifications: Enabled');

  // Startup notification
  await sendTelegramMessage('FirstCry Stock Checker started successfully.');

  console.log('Telegram connection successful.');

  while (!isStopping) {
    console.log('\n========== NEW STOCK CHECK ==========');
    console.log('Time:', new Date().toLocaleString());

    try {
      const products = await fetchShortlist();

      console.log(`Products received: ${products.length}`);

      await processProducts(products, history);

      // Reset consecutive error count after a successful full cycle
      if (errorCount > 0) {
        console.log('Stock check successful. Error counter reset.');
        errorCount = 0;
      }
    } catch (error) {
      const stopped = await reportError(error, 'Stock checking / product processing');

      if (stopped) return;

      // Stop immediately for authentication or rate-limit errors
      if ([401, 403, 429].includes(error.statusCode)) {
        await stopApplication(`FirstCry returned HTTP ${error.statusCode}. Manual intervention required.`);
        return;
      }
    }

    if (isStopping) return;

    const delay = getRandomDelay();

    console.log(`Next check in ${delay} seconds.`);

    await sleep(delay * 1000);
  }
}

// Handle unexpected uncaught exceptions
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);

  if (!isStopping) {
    await reportError(error, 'Uncaught exception');
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled promise rejection:', reason);

  if (!isStopping) {
    await reportError(reason, 'Unhandled promise rejection');
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await stopApplication('Application stopped manually using SIGINT.');
});

process.on('SIGTERM', async () => {
  await stopApplication('Application stopped using SIGTERM.');
});

// Start application
main().catch(async (error) => {
  console.error('Application startup failed:', error);

  if (!isStopping) {
    await reportError(error, 'Application startup');
  }
});
