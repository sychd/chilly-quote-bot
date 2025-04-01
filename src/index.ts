// File: src/index.ts

// Define types for our application
interface User {
	id: string;
	name: string;
	last_received_quotes: string[];
  }
  
  interface Quote {
	id: string;
	quote: string;
	title: string;
	link: string;
  }
  
  interface Env {
	USER_STORAGE: KVNamespace;
	TELEGRAM_BOT_TOKEN: string;
	QUOTES_CACHE: KVNamespace;
  }
  
  interface TelegramUpdate {
	update_id: number;
	message?: {
	  message_id: number;
	  from: {
		id: number;
		first_name: string;
		username?: string;
	  };
	  chat: {
		id: number;
	  };
	  text?: string;
	};
  }
  
  const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
  const QUOTES_API = 'https://chillyhill.me/api/book-quotes';
  const QUOTES_CACHE_KEY = 'daily_quotes';
  
  // Helper function to send a message to a Telegram user
  async function sendTelegramMessage(token: string, chatId: string, text: string, parseMode: string = 'HTML') {
	const url = `${TELEGRAM_API_BASE}${token}/sendMessage`;
	console.log('[sendTelegramMessage]' , JSON.stringify({chatId, text, parseMode}));
	const response = await fetch(url, {
	  method: 'POST',
	  headers: {
		'Content-Type': 'application/json',
	  },
	  body: JSON.stringify({
		chat_id: chatId,
		text,
		parse_mode: parseMode,
	  }),
	});
  
	if (!response.ok) {
	  const error = await response.text();
	  console.error(`Failed to send message to ${chatId}: ${error}`);
	  throw new Error(`Failed to send message: ${error}`);
	}
  
	return await response.json();
  }
  
  // Helper function to fetch quotes
  async function fetchQuotes(env: Env): Promise<Quote[]> {
	// Try to get cached quotes first
	const cachedQuotes = await env.QUOTES_CACHE.get(QUOTES_CACHE_KEY);
	
	if (cachedQuotes) {
	  return JSON.parse(cachedQuotes);
	}
	
	// Fetch fresh quotes if none in cache
	const response = await fetch(QUOTES_API);
	
	if (!response.ok) {
	  throw new Error('Failed to fetch quotes from API');
	}
	
	const quotes = await response.json() as Quote[];
	
	// Cache the quotes for 24 hours (86400 seconds)
	await env.QUOTES_CACHE.put(QUOTES_CACHE_KEY, JSON.stringify(quotes), { expirationTtl: 86400 });
	
	return quotes;
  }
  
  // Helper function to get a random quote that wasn't sent recently to this user
  function getRandomQuote(quotes: Quote[], user: User): Quote {
	// Filter out quotes that were recently sent to this user
	const availableQuotes = quotes.filter(quote => 
	  !user.last_received_quotes.includes(quote.id)
	);
	
	// If all quotes were recently sent, just pick a random one
	if (availableQuotes.length === 0) {
	  return quotes[Math.floor(Math.random() * quotes.length)];
	}
	
	// Return a random quote from available ones
	return availableQuotes[Math.floor(Math.random() * availableQuotes.length)];
  }
  
  // Helper function to update user's received quotes
  function updateUserQuotes(user: User, quoteId: string): User {
	const updatedUser = { ...user };
	
	// Add the new quote ID to the list
	updatedUser.last_received_quotes.push(quoteId);
	
	// Keep only the last 10 quotes
	if (updatedUser.last_received_quotes.length > 10) {
	  updatedUser.last_received_quotes = updatedUser.last_received_quotes.slice(-10);
	}
	
	return updatedUser;
  }
  
  // Send a quote to a specific user
  async function sendQuoteToUser(env: Env, userId: string, chatId: string): Promise<void> {
	try {
	  const userKey = `user:${userId}`;
	  const userJson = await env.USER_STORAGE.get(userKey);
	  
	  if (!userJson) {
		// User not found, send error message
		await sendTelegramMessage(
		  env.TELEGRAM_BOT_TOKEN,
		  chatId,
		  "You're not registered. Please send /start to register for quotes."
		);
		return;
	  }
	  
	  const user = JSON.parse(userJson) as User;
	  
	  // Fetch quotes
	  let quotes: Quote[];
	  try {
		quotes = await fetchQuotes(env);
	  } catch (error) {
		console.error('Failed to fetch quotes:', error);
		await sendTelegramMessage(
		  env.TELEGRAM_BOT_TOKEN,
		  chatId,
		  "We were not able to retrieve the record."
		);
		return;
	  }
	  
	  // Select a random quote
	  const selectedQuote = getRandomQuote(quotes, user);
	  
	  // Format the message
	  const message = `${selectedQuote.quote}\n<a href="${selectedQuote.link}">${selectedQuote.title}</a>`;
	  
	  // Send the quote
	  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message);
	  
	  // Update user's received quotes
	  const updatedUser = updateUserQuotes(user, selectedQuote.id);
	  await env.USER_STORAGE.put(userKey, JSON.stringify(updatedUser));
	  
	  console.log(`Quote sent to user ${user.id} (${user.name}) via command`);
	} catch (error) {
	  console.error(`Error sending quote to user ${userId}:`, error);
	  await sendTelegramMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		"Sorry, something went wrong while trying to send you a quote."
	  );
	}
  }
  
  // Handler for webhook events
  async function handleWebhook(request: Request, env: Env): Promise<Response> {
	try {
	  const update = await request.json() as TelegramUpdate;
	  
	  if (!update.message) {
		return new Response('No message in the update', { status: 200 });
	  }
	  
	  const userId = update.message.from.id.toString();
	  const chatId = update.message.chat.id.toString();
	  const messageText = update.message.text || '';
	  const userName = update.message.from.username || update.message.from.first_name;
	  console.log('[handleWebhook]' , JSON.stringify({userId, chatId, messageText, userName}));

	  // Handle /start command
	  if (messageText === '/start') {
		const userKey = `user:${userId}`;
		
		// Check if user already exists
		const existingUser = await env.USER_STORAGE.get(userKey);
		
		if (!existingUser) {
		  // Register new user
		  const newUser: User = {
			id: userId,
			name: userName,
			last_received_quotes: [],
		  };
		  
		  await env.USER_STORAGE.put(userKey, JSON.stringify(newUser));
		  
		  // Send welcome message
		  await sendTelegramMessage(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			`Welcome, ${userName}! You've been registered to receive daily book quotes. You'll receive your first quote soon.`
		  );
		} else {
		  // User already registered
		  await sendTelegramMessage(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			`Hello again, ${userName}! You're already registered to receive daily book quotes.`
		  );
		}
		
		return new Response('Processed /start command', { status: 200 });
	  }
	  
	  // Handle /stop command
	  if (messageText === '/stop') {
		const userKey = `user:${userId}`;
		
		// Remove user from KV storage
		await env.USER_STORAGE.delete(userKey);
		
		// Log removal and send confirmation
		console.log(`User ${userId} (${userName}) removed from subscribers`);
		
		await sendTelegramMessage(
		  env.TELEGRAM_BOT_TOKEN,
		  chatId,
		  `You've been unsubscribed from daily book quotes. We hope you enjoyed the service!`
		);
		
		return new Response('Processed /stop command', { status: 200 });
	  }
	  
	  // Handle /quote command
	  if (messageText === '/quote') {
		await sendQuoteToUser(env, userId, chatId);
		return new Response('Processed /quote command', { status: 200 });
	  }
	  
	  // Default response for other messages
	  await sendTelegramMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		`I'm a book quotes bot. Available commands:\n/start - Subscribe to daily quotes\n/stop - Unsubscribe from quotes\n/quote - Get a quote immediately`
	  );
	  
	  return new Response('Processed message', { status: 200 });
	} catch (error) {
	  console.error('Error handling webhook:', error);
	  const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
	  return new Response(`Error: ${errorMessage}`, { status: 500 });
	}
  }
  
  // Handler for CRON scheduled job to send daily quotes
  async function handleScheduled(env: Env): Promise<void> {
	console.log('Running scheduled quote sending...');
	
	try {
	  // Fetch all users
	  const usersList = await env.USER_STORAGE.list({ prefix: 'user:' });
	  
	  if (!usersList.keys.length) {
		console.log('No users registered for quotes');
		return;
	  }
	  
	  // Fetch quotes once for all users
	  let quotes: Quote[];
	  try {
		quotes = await fetchQuotes(env);
	  } catch (error) {
		console.error('Failed to fetch quotes:', error);
		// Don't proceed further if we can't get quotes
		return;
	  }
	  
	  // Send quotes to each user
	  for (const key of usersList.keys) {
		try {
		  const userJson = await env.USER_STORAGE.get(key.name);
		  
		  if (!userJson) {
			console.error(`User data not found for key ${key.name}`);
			continue;
		  }
		  
		  const user = JSON.parse(userJson) as User;
		  
		  // Select a random quote
		  const selectedQuote = getRandomQuote(quotes, user);
		  
		  // Format the message
		  const message = `${selectedQuote.quote}\n<a href="${selectedQuote.link}">${selectedQuote.title}</a>`;
		  
		  // Send the quote
		  try {
			await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, user.id, message);
			console.log(`Quote sent to user ${user.id} (${user.name})`);
			
			// Update user's received quotes
			const updatedUser = updateUserQuotes(user, selectedQuote.id);
			await env.USER_STORAGE.put(key.name, JSON.stringify(updatedUser));
		  } catch (error) {
			console.error(`Failed to send message to user ${user.id}:`, error);
			// Continue with next user if sending fails
		  }
		} catch (error) {
		  console.error(`Error processing user ${key.name}:`, error);
		}
	  }
	  
	  console.log('Finished sending daily quotes');
	} catch (error) {
	  console.error('Error in scheduled job:', error);
	}
  }
  
  // Main worker handler
  export default {
	async fetch(request: Request, env: Env): Promise<Response> {
	  const url = new URL(request.url);
	  
	  // Handle webhook events from Telegram
	  if (request.method === 'POST' && url.pathname === '/webhook') {
		return handleWebhook(request, env);
	  }
	  
	  // Manual trigger for debugging
	  if (request.method === 'GET' && url.pathname === '/debug/send-quotes') {
		// Check for a simple auth token (you should use a better auth method in production)
		const authHeader = request.headers.get('Authorization');
		if (!authHeader || authHeader !== `Bearer ${env.TELEGRAM_BOT_TOKEN.substring(0, 10)}`) {
		  return new Response('Unauthorized', { status: 401 });
		}
		
		try {
		  await handleScheduled(env);
		  return new Response('Manual quote sending completed', { status: 200 });
		} catch (error) {
		  const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		  return new Response(`Error: ${errorMessage}`, { status: 500 });
		}
	  }
	  
	  // Health check endpoint
	  if (request.method === 'GET' && url.pathname === '/health') {
		return new Response('OK', { status: 200 });
	  }
	  
	  // Default response for other requests
	  return new Response('Book Quotes Bot is running!', { status: 200 });
	},
	
	// Scheduled handler for CRON job
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
	  ctx.waitUntil(handleScheduled(env));
	},
  };