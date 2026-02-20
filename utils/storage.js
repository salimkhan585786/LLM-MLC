import AsyncStorage from '@react-native-async-storage/async-storage';

const MESSAGES_KEY = '@chat_messages';
const PREFERENCES_KEY = '@user_preferences';
const PREFERENCES_CACHE_KEY = '@user_preferences_cache';

// In-memory cache with TTL to reduce AsyncStorage reads
let preferencesCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds

// Compiled regex patterns for better performance (pre-compiled outside function)
const LIKE_PATTERNS = [
  { pattern: /i (like|love|enjoy|prefer|am interested in|am passionate about|spend time on|spend my time) (?!don't|do not)(.+?)(?:\.|$)/i, group: 2 },
  { pattern: /my favorite (?:is|are) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i'm (?:a|an) (.+?) (?:fan|person|lover|enthusiast)/i, group: 1 },
  { pattern: /my (hobby|hobbies|interest|interests|like|likes|passion|passions) (?:are|is) (.+?)(?:\.|$)/i, group: 2 },
  { pattern: /i (enjoy|love|like|do|play|collect|watch|read|practice|build|create|explore) (.+?)(?:\.|$)/i, group: 2 },
  { pattern: /i(?:'m|'ve|'d) (?:into|obsessed with|fascinated by|hooked on) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /favorite (?:hobby|thing|activity|interest|pastime|way to relax) (?:is|are) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i love to (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /one of my (hobbies|interests|likes|favorites) is (.+?)(?:\.|$)/i, group: 2 },
  { pattern: /i(?:'m|'ve) always enjoyed (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /my go-to (activity|hobby|interest) is (.+?)(?:\.|$)/i, group: 2 },
  { pattern: /i find (.+?) relaxing|exciting|fulfilling/i, group: 1 },
  // Put these FIRST in the LIKE_PATTERNS array
{ pattern: /i like (.+?)(?:and\s+)?i\s/i, group: 1 },                    // "I like A and I"
{ pattern: /i like (.+?)(?:\s+and\s+|\s*,\s*)/i, group: 1 },            // "I like A, B and C"
{ pattern: /i (?:like|love|enjoy) (.+?)(?:\s+and\s+|\s*,\s*|$)/gi, group: 1 }, // repeated matches
];

const DISLIKE_PATTERNS = [
  { pattern: /i (?:don't|do not) (?:like|love|enjoy|prefer) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i hate (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i (?:can't|cannot) stand (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i(?:'m|'ve) not into (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i avoid (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /(.+?) bores me/i, group: 1 },
  { pattern: /i find (.+?) annoying|frustrating|unappealing/i, group: 1 }
];

const NAME_PATTERNS = [
  { pattern: /my name is (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i(?:'m| am) called (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /call me (.+?)(?:\.|$)/i, group: 1 }
];

// Topic keywords as a Set for O(1) lookup
const TOPIC_KEYWORDS = new Set([
  'movies', 'music', 'books', 'sports', 'food', 'travel', 
  'technology', 'science', 'art', 'politics', 'gaming', 'fashion',
  'health', 'fitness', 'business', 'education', 'nature', 'animals',
  'coding', 'programming', 'painting', 'biking', 'writing', 'journaling'
]);

// Message queue for batch processing
let messageQueue = [];
let isProcessingQueue = false;
const BATCH_SIZE = 5;
const BATCH_DELAY = 1000; // Process queue every second

// Debounced save to prevent frequent writes
let saveTimeout = null;
const SAVE_DELAY = 2000; // 2 seconds

export const storeMessage = async (message) => {
  console.log('HIT Storing message:', message);
  const existing = await loadMessages();
  const updated = [...existing, message];
  
  // Store message asynchronously without blocking
  setTimeout(async () => {
    try {
      await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to store message:', error);
    }
  }, 0);
  
  // If it's a user message, queue for preference extraction
 const seen = new Set();
if (message.role === 'user' && !seen.has(message.content)) {
  seen.add(message.content);
  queueMessageForPreferenceExtraction(message.content);
}
  
  return updated;
};

// Queue messages for batch processing
const queueMessageForPreferenceExtraction = (message) => {
  console.log('HIT Queueing message for preference extraction:', message);
  messageQueue.push(message);
  
  if (!isProcessingQueue) {
    isProcessingQueue = true;
    setTimeout(processMessageQueue, BATCH_DELAY);
  }
};

// Process messages in batches
const processMessageQueue = async () => {
  console.log('HIT Processing message queue. Queue length:', messageQueue.length);
  if (messageQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  
  const batch = messageQueue.splice(0, BATCH_SIZE);
  
  try {
    const prefs = await getUserPreferences();
    let updated = false;
    
    for (const message of batch) {
      const messageUpdated = extractPreferencesFromMessageSync(message, prefs);
      updated = updated || messageUpdated;
    }
    
    if (updated) {
      await debouncedSavePreferences(prefs);
    }
  } catch (error) {
    console.error('Error processing message batch:', error);
  }
  
  if (messageQueue.length > 0) {
    setTimeout(processMessageQueue, BATCH_DELAY);
  } else {
    isProcessingQueue = false;
  }
};

// Helper to process captured text into multiple items (handles lists like "A, B, and C")
const processCapturedItems = (captured) => {
  const cleaned = captured
    .replace(/\n+/g, ', ')           // newlines → comma + space
    .replace(/\s+and\s+/gi, ', ')    // "and" → comma
    .replace(/\s*,\s*/g, ',')        // normalize commas
    .replace(/\s+for\s+currently/gi, ''); // remove trailing noise

  return cleaned
    .split(',')
    .map(s => s.trim().toLowerCase())
    .map(s => s.replace(/^(the|a|an|my|i|and|or)\s+/i, ''))
    .filter(s => s.length > 3 && !/^(until|for|currently|about|in)$/i.test(s));
};

// Synchronous version for batch processing
const extractPreferencesFromMessageSync = (message, prefs) => {
  console.log('HIT Extracting preferences from message:', message);
  const lowerMessage = message.toLowerCase();
  let updated = false;

  // Extract name if mentioned
  for (const { pattern, group } of NAME_PATTERNS) {
    const match = message.match(pattern);
    if (match && match[group]) {
      const name = match[group].trim();
      if (name.length > 0 && (!prefs.name || prefs.name !== name)) {
        prefs.name = name;
        updated = true;
      }
      break;
    }
  }

  // Process likes (break early if no match to save CPU)
  for (const { pattern, group } of LIKE_PATTERNS) {
    const match = lowerMessage.match(pattern);
    if (match && match[group]) {
      const captured = match[group].trim();
      const likes = processCapturedItems(captured);
      likes.forEach(like => {
        if (like.length > 0 && !prefs.likes.includes(like)) {
          prefs.likes.push(like);
          updated = true;
          if (prefs.likes.length > 20) prefs.likes.shift();
        }
      });
      break; // Found a like, no need to check other patterns
    }
  }

  // Process dislikes
  for (const { pattern, group } of DISLIKE_PATTERNS) {
    const match = lowerMessage.match(pattern);
    if (match && match[group]) {
      const captured = match[group].trim();
      const dislikes = processCapturedItems(captured);
      dislikes.forEach(dislike => {
        if (dislike.length > 0 && !prefs.dislikes.includes(dislike)) {
          prefs.dislikes.push(dislike);
          updated = true;
          if (prefs.dislikes.length > 20) prefs.dislikes.shift();
        }
      });
      break;
    }
  }

  // Extract topics using Set for O(1) lookup
  const words = lowerMessage.split(/\s+/);
  for (const word of words) {
    if (TOPIC_KEYWORDS.has(word) && !prefs.topics.includes(word)) {
      prefs.topics.push(word);
      updated = true;
      if (prefs.topics.length > 15) prefs.topics.shift();
    }
  }

  // Track behavior patterns with integer counters
  if (message.includes('?')) {
    prefs.behaviors.asksQuestions = (prefs.behaviors.asksQuestions || 0) + 1;
    updated = true;
  }
  
  if (message.length > 200) {
    prefs.behaviors.detailedResponses = (prefs.behaviors.detailedResponses || 0) + 1;
    updated = true;
  }
  
  // Track message length patterns
  const wordCount = words.length;
  if (wordCount < 5) {
    prefs.behaviors.shortMessages = (prefs.behaviors.shortMessages || 0) + 1;
    updated = true;
  } else if (wordCount > 50) {
    prefs.behaviors.veryLongMessages = (prefs.behaviors.veryLongMessages || 0) + 1;
    updated = true;
  }

  // Store recent user statements for better context (last 10 raw messages)
 prefs.recentUserStatements = prefs.recentUserStatements || [];
if (!prefs.recentUserStatements.includes(message)) {
  prefs.recentUserStatements.push(message);
  if (prefs.recentUserStatements.length > 10) prefs.recentUserStatements.shift();
  updated = true;
}

  return updated;
};

// Debounced save function
const debouncedSavePreferences = (prefs) => {
  console.log('HIT Debounced save preferences called:', prefs);
  return new Promise((resolve) => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    
    saveTimeout = setTimeout(async () => {
      try {
        await AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
        // Update cache
        preferencesCache = prefs;
        cacheTimestamp = Date.now();

console.log('Current user profile:', prefs);
        resolve(prefs);
      } catch (error) {
        console.error('Failed to save preferences:', error);
        resolve(prefs);
      }
      saveTimeout = null;
    }, SAVE_DELAY);
  });
};

export const loadMessages = async () => {
  console.log('HIT Loading messages from storage');
  try {
    const data = await AsyncStorage.getItem(MESSAGES_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Failed to load messages:', error);
    return [];
  }
};

export const getUserPreferences = async () => {
  console.log('HIT Getting user preferences');
  // Check cache first
  if (preferencesCache && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return preferencesCache;
  }
  
  try {
    const data = await AsyncStorage.getItem(PREFERENCES_KEY);
    const prefs = data ? JSON.parse(data) : { 
      name: '',
      likes: [], 
      dislikes: [], 
      topics: [], 
      behaviors: {},
      recentUserStatements: []
    };
    
    // Update cache
    preferencesCache = prefs;
    cacheTimestamp = Date.now();
    
    return prefs;
  } catch (error) {
    console.error('Failed to load preferences:', error);
    return { name: '', likes: [], dislikes: [], topics: [], behaviors: {}, recentUserStatements: [] };
  }
};

export const updateUserPreferences = async (newPrefs) => {
  console.log('HIT Updating user preferences:', newPrefs);
  // Update cache immediately
  preferencesCache = newPrefs;
  cacheTimestamp = Date.now();
  
  // Debounce the actual save
  await debouncedSavePreferences(newPrefs);
};

export const addUserLike = async (like) => {
  console.log('HIT Adding user like:', like);
  const prefs = await getUserPreferences();
  if (like && like.trim() && !prefs.likes.includes(like.trim())) {
    prefs.likes.push(like.trim());
    if (prefs.likes.length > 20) prefs.likes.shift();
    await updateUserPreferences(prefs);
  }
  return prefs;
};

export const addUserDislike = async (dislike) => {
  console.log('HIT Adding user dislike:', dislike);
  const prefs = await getUserPreferences();
  if (dislike && dislike.trim() && !prefs.dislikes.includes(dislike.trim())) {
    prefs.dislikes.push(dislike.trim());
    if (prefs.dislikes.length > 20) prefs.dislikes.shift();
    await updateUserPreferences(prefs);
  }
  return prefs;
};

export const clearUserPreferences = async () => {
  console.log('HIT Clearing user preferences');
  await AsyncStorage.removeItem(PREFERENCES_KEY);
  preferencesCache = null;
  cacheTimestamp = 0;
  messageQueue = [];
  isProcessingQueue = false;
};

// Optional: Pre-warm the cache
export const prewarmPreferencesCache = async () => {
  console.log('HIT Pre-warming preferences cache');
  await getUserPreferences();
};