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
  { pattern: /i (like|love|enjoy|prefer) (?!don't|do not)(.+?)(?:\.|$)/i, group: 2 },
  { pattern: /my favorite (?:is|are) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i'm (?:a|an) (.+?) (?:fan|person|lover)/i, group: 1 }
];

const DISLIKE_PATTERNS = [
  { pattern: /i (?:don't|do not) (?:like|love|enjoy|prefer) (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i hate (.+?)(?:\.|$)/i, group: 1 },
  { pattern: /i (?:can't|cannot) stand (.+?)(?:\.|$)/i, group: 1 }
];

// Topic keywords as a Set for O(1) lookup
const TOPIC_KEYWORDS = new Set([
  'movies', 'music', 'books', 'sports', 'food', 'travel', 
  'technology', 'science', 'art', 'politics', 'gaming', 'fashion',
  'health', 'fitness', 'business', 'education', 'nature', 'animals'
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
  if (message.role === 'user') {
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
  
  // Take batch from queue
  const batch = messageQueue.splice(0, BATCH_SIZE);
  
  try {
    // Load preferences once for the entire batch
    const prefs = await getUserPreferences();
    let updated = false;
    
    // Process each message in the batch
    for (const message of batch) {
      const messageUpdated = extractPreferencesFromMessageSync(message, prefs);
      updated = updated || messageUpdated;
    }
    
    // Save only once if any updates occurred
    if (updated) {
      await debouncedSavePreferences(prefs);
    }
  } catch (error) {
    console.error('Error processing message batch:', error);
  }
  
  // Process next batch if queue still has items
  if (messageQueue.length > 0) {
    // setTimeout(processMessageQueue, BATCH_DELAY);
  } else {
    isProcessingQueue = false;
  }
};

// Synchronous version for batch processing
const extractPreferencesFromMessageSync = (message, prefs) => {
  console.log('HIT Extracting preferences from message:', message);
  const lowerMessage = message.toLowerCase();
  let updated = false;

  // Process likes (break early if no match to save CPU)
  for (const { pattern, group } of LIKE_PATTERNS) {
    const match = lowerMessage.match(pattern);
    if (match && match[group]) {
      const like = match[group].trim();
      if (like.length > 0 && !prefs.likes.includes(like)) {
        prefs.likes.push(like);
        updated = true;
        // Keep only last 20 likes to prevent unbounded growth
        if (prefs.likes.length > 20) prefs.likes.shift();
      }
      break; // Found a like, no need to check other patterns
    }
  }

  // Process dislikes
  for (const { pattern, group } of DISLIKE_PATTERNS) {
    const match = lowerMessage.match(pattern);
    if (match && match[group]) {
      const dislike = match[group].trim();
      if (dislike.length > 0 && !prefs.dislikes.includes(dislike)) {
        prefs.dislikes.push(dislike);
        updated = true;
        if (prefs.dislikes.length > 20) prefs.dislikes.shift();
      }
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
        console.log('Preferences saved:', prefs);
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
      likes: [], 
      dislikes: [], 
      topics: [], 
      behaviors: {} 
    };
    
    // Update cache
    preferencesCache = prefs;
    cacheTimestamp = Date.now();
    
    return prefs;
  } catch (error) {
    console.error('Failed to load preferences:', error);
    return { likes: [], dislikes: [], topics: [], behaviors: {} };
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