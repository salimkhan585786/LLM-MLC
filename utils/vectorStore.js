import { llama } from '@react-native-ai/llama';
import { embed } from 'ai';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Asset from 'expo-asset';
// In‑memory vector store
let vectorStore = []; // { text, embedding, timestamp }
let embedModel = null;

// Path to the bundled model in your app
const BUNDLED_MODEL_NAME = 'bge-small-en-v1.5-q4_k_m.gguf';

export const initVectorStore = async () => {
  try {
    const saved = await AsyncStorage.getItem('@embeddings');
    if (saved) {
      vectorStore = JSON.parse(saved);
      console.log(`📚 Loaded ${vectorStore.length} saved embeddings`);
    }
  } catch (error) {
    console.log('No saved embeddings found');
  }
};

const saveEmbeddings = async () => {
  try {
    const toSave = vectorStore.slice(-100);
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
      sentiment: text.includes('happy') ? 'positive' : 'neutral' // Simple sentiment tagging
    });
    
    await saveEmbeddings();
    
    return embedding;
  } catch (error) {
    console.error('Failed to add message embedding:', error);
    return null;
  }
};

export const findSimilarMessages = async (query, topK = 3) => {
  if (!embedModel || vectorStore.length === 0) return [];
  
  try {
    const { embedding: queryEmbedding } = await embed({ 
      model: embedModel, 
      value: query 
    });

    const similarities = vectorStore.map((item) => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding),
    }));
    
    similarities.sort((a, b) => b.similarity - a.similarity);
    
    return similarities.slice(0, topK).map((item) => item.text);
  } catch (error) {
    console.error('Failed to find similar messages:', error);
    return [];
  }
};

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