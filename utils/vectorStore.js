import { loadMessages } from './storage';

// In‑memory message store for quick access
let messageStore = []; // { text, sentiment, timestamp }

// Simple sentiment detection (expand with more words/rules)
function detectSentiment(text) {
  // console.log('HIT Detecting sentiment for text:', text);
  const positiveWords = ['happy', 'great', 'love', 'good', 'awesome', 'enjoy', 'like', 'favorite'];
  const negativeWords = ['sad', 'bad', 'hate', 'wrong', 'dislike', 'avoid'];
  if (positiveWords.some(w => text.toLowerCase().includes(w))) return 'positive';
  if (negativeWords.some(w => text.toLowerCase().includes(w))) return 'negative';
  return 'neutral';
}

export const addMessageToStore = async (text) => {
  console.log('HIT Adding message to store:', text);
  const sentiment = detectSentiment(text);
  messageStore.push({ text, sentiment, timestamp: Date.now() });
  console.log('Message store updated. Current count:', messageStore.length);
// console.log('Latest stored messages:', messageStore.slice(-3).map(m => m.text));
  if (messageStore.length > 100) {
    messageStore.shift();
  }
};

export const findSimilarMessages = async (query, topK = 4) => {
  console.log('HIT Finding similar messages for query:', query);
  if (messageStore.length === 0) {
    // Lazy load from persistent storage if not in memory
    const history = await loadMessages();
    messageStore = history.map((m) => ({
      text: m.content,
      sentiment: detectSentiment(m.content),
      timestamp: m.timestamp,
    }));
    // Sort by recency and cap at 100
    messageStore.sort((a, b) => b.timestamp - a.timestamp);
    messageStore = messageStore.slice(0, 100);
  }

  const querySentiment = detectSentiment(query);
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2); // More flexible, ignore very short words

  const scores = messageStore.map((item) => {
    let score = 0;
    const lowerText = item.text.toLowerCase();
    queryWords.forEach((word) => {
      if (lowerText.includes(word)) score += 1;
    });
    // Boost recent messages more aggressively
    score *= 1 + ((Date.now() - item.timestamp) < 86400000 ? 0.5 : 0.2); // 50% boost if within 1 day
    return { ...item, score };
  });

  const filtered = scores
    .filter((item) => item.score > 0 && (item.sentiment === querySentiment || querySentiment === 'neutral'))
    .sort((a, b) => b.score - a.score);

  // Fallback: If no strong matches, include last 3 recent messages for context
  if (filtered.length === 0) {
    return messageStore.slice(-3).map((item) => item.text.slice(0, 100) + (item.text.length > 100 ? '...' : ''));
  }

  // Dynamic topK: Up to 6 if many high scores, but truncate each text to 100 chars
  const maxItems = filtered.length > 4 ? Math.min(6, filtered.length) : topK;
  return filtered.slice(0, maxItems).map((item) => item.text.slice(0, 100) + (item.text.length > 100 ? '...' : ''));
};