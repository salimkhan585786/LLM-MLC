import { llama } from '@react-native-ai/llama';
import { embed } from 'ai';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
// In‑memory vector store
let vectorStore = []; // { text, embedding, timestamp }
let embedModel = null;

// Path to the bundled model in your app
const BUNDLED_MODEL_NAME = 'bge-small-en-v1.5-q4_k_m.gguf';


const saveEmbeddings = async () => {
  try {
    // Prune old/low-relevance: Keep top 100 recent + high similarity (optional periodic call)
    vectorStore.sort((a, b) => b.timestamp - a.timestamp); // Recent first
    const toSave = vectorStore.slice(0, 100); // Cap at 100
    await AsyncStorage.setItem('@embeddings', JSON.stringify(toSave));
  } catch (error) {
    console.error('Failed to save embeddings:', error);
  }
};


export const initEmbeddingModel = async () => {
  try {
    console.log('🔄 Initializing embedding model with bundled file...');
    
    // Copy model from assets to documents directory
  const url = 'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf';  // find real direct link
const dest = FileSystem.documentDirectory + BUNDLED_MODEL_NAME;
if (!(await FileSystem.getInfoAsync(dest)).exists) {
  await FileSystem.downloadAsync(url, dest);
}
    
    console.log('🔧 Creating model instance from:', dest);
    
    // Create embedding model
    embedModel = llama.textEmbeddingModel(dest, {
      normalize: true,
      contextParams: {
        n_ctx: 512,
        n_gpu_layers: 0, // Start with CPU for compatibility
      }
    });
    
    console.log('⚙️ Preparing model...');
    await embedModel.prepare();
    
    console.log('✅✅ Embedding model ready!');
    
    // Test the model
    try {
      const testEmbedding = await embed({
        model: embedModel,
        value: "Hello, this is a test."
      });
      console.log(`✅ Model test passed! Embedding dimension: ${testEmbedding.embedding.length}`);
    } catch (testError) {
      console.warn('⚠️ Model test warning:', testError.message);
    }
    
  } catch (error) {
    console.error('❌ Failed to initialize embedding model:', error);
    throw error;
  }
};

export const addMessageEmbedding = async (text) => {
  if (!embedModel) {
    console.warn('Embedding model not available');
    return null;
  }
  
  try {
    const { embedding } = await embed({ 
      model: embedModel, 
      value: text 
    });
    
    vectorStore.push({ 
      text, 
      embedding, 
      timestamp: Date.now(),
      sentiment: detectSentiment(text) // Improved tagging
    });
    
    await saveEmbeddings();
    
    return embedding;
  } catch (error) {
    console.error('Failed to add message embedding:', error);
    return null;
  }
};
// Simple sentiment detection (expand with more words/rules)
function detectSentiment(text) {
  const positiveWords = ['happy', 'great', 'love', 'good', 'awesome'];
  const negativeWords = ['sad', 'bad', 'hate', 'wrong'];
  if (positiveWords.some(w => text.toLowerCase().includes(w))) return 'positive';
  if (negativeWords.some(w => text.toLowerCase().includes(w))) return 'negative';
  return 'neutral';
}
export const findSimilarMessages = async (query, topK = 4) => {
  if (!embedModel || vectorStore.length === 0) return [];
  
  try {
    const { embedding: queryEmbedding } = await embed({ 
      model: embedModel, 
      value: query 
    });

    // Query sentiment for filtering
    const querySentiment = detectSentiment(query);

    const similarities = vectorStore.map((item) => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding) * (1 + (item.timestamp / Date.now()) * 0.2), // Weight recent 20% more
    }));
    
    // Filter: High threshold, matching sentiment, relevant to query (simple keyword overlap check)
    const filtered = similarities
      .filter(item => item.similarity > 0.7 && item.sentiment === querySentiment && hasKeywordOverlap(query, item.text))
      .sort((a, b) => b.similarity - a.similarity);
    
    // Dynamic topK: Up to 6 if many high scores, but truncate each text to 100 chars
    const maxItems = filtered.length > 4 ? Math.min(6, filtered.length) : topK;
    return filtered.slice(0, maxItems).map(item => item.text.slice(0, 100) + (item.text.length > 100 ? '...' : '')); // Truncate for efficiency
  } catch (error) {
    console.error('Failed to find similar messages:', error);
    return [];
  }
};

// Simple overlap: At least 1 shared non-stop word
function hasKeywordOverlap(query, text) {
  const stopWords = new Set(['the', 'is', 'a', 'an', 'to', 'in', 'on', 'and', 'or']);
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w));
  const textWords = text.toLowerCase().split(/\s+/).filter(w => !stopWords.has(w));
  return queryWords.some(qw => textWords.includes(qw));
}
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

export const unloadEmbeddingModel = async () => {
  if (embedModel) {
    await embedModel.unload();
    embedModel = null;
  }
};

export const getVectorStoreStats = () => {
  return {
    messageCount: vectorStore.length,
    modelLoaded: embedModel !== null
  };
};