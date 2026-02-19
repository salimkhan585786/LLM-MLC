import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { mlc, MLCEngine } from '@react-native-ai/mlc';
import { generateText } from 'ai';
import {
  storeMessage,
  loadMessages,
  updateUserPreferences,
  getUserPreferences,
} from '../utils/storage';

import { initEmbeddingModel, addMessageEmbedding, findSimilarMessages, unloadEmbeddingModel, getVectorStoreStats } from '../utils/vectorStore';

const LLM_MODEL_ID = 'Llama-3.2-3B-Instruct';   // main chat model

export default function ChatScreen() {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [modelsReady, setModelsReady] = useState(false);
  const llmModel = useRef(null);
  const embedModel = useRef(null);

// Add cleanup in useEffect
useEffect(() => {
  initializeModels();
  loadHistory();
  
  return () => {
    unloadEmbeddingModel();
  };
}, []);

  const initializeModels = async () => {
  try {
    // 1. MLC models
    const available = await MLCEngine.getModels();
    console.log('Available models:', available);

    llmModel.current = mlc.languageModel(LLM_MODEL_ID);
    setDownloadProgress({ model: LLM_MODEL_ID, percent: 0 });
    await llmModel.current.download((event) => {
      setDownloadProgress({ model: LLM_MODEL_ID, percent: event.percentage });
    });
    await llmModel.current.prepare();

    // 2. Llama embedding model
    setDownloadProgress({ model: 'Embedding Model', percent: 0 });
    await initEmbeddingModel();

    setDownloadProgress(null);
    setModelsReady(true);
    
    // Log stats
    const stats = getVectorStoreStats();
    console.log('Vector store stats:', stats);
  } catch (error) {
    console.error('Model initialization failed:', error);
  }
};


  const loadHistory = async () => {
    const history = await loadMessages();
    setMessages(history);
    await initVectorStore();
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !modelsReady) return;

    const userMsg = { role: 'user', content: inputText, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setIsLoading(true);

    try {
      await storeMessage(userMsg);
      await addMessageEmbedding(userMsg.content); // <-- no model passed

      const similar = await findSimilarMessages(userMsg.content, 3);
      const similarContext = similar.length
        ? `Related past conversations:\n${similar.join('\n')}`
        : '';

      const prefs = await getUserPreferences();
      const prefsText = `User preferences: likes ${prefs.likes.join(', ')}, dislikes ${prefs.dislikes.join(', ')}`;

      const systemPrompt = `You are a helpful assistant. ${prefsText} ${similarContext}`;
      const fullPrompt = `${systemPrompt}\n\nUser: ${userMsg.content}\nAssistant:`;

      const result = await generateText({
        model: llmModel.current,
        prompt: fullPrompt,
        temperature: 0.7,
        maxTokens: 500,
      });

      const assistantMsg = { role: 'assistant', content: result.text, timestamp: Date.now() };
      setMessages((prev) => [...prev, assistantMsg]);
      await storeMessage(assistantMsg);

      await updatePreferencesFromMessage(userMsg.content);
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const updatePreferencesFromMessage = async (text) => {
    const prefs = await getUserPreferences();
    const likeMatch = text.match(/i like (\w+)/i);
    if (likeMatch) {
      const item = likeMatch[1].toLowerCase();
      if (!prefs.likes.includes(item)) {
        prefs.likes.push(item);
        await updateUserPreferences(prefs);
      }
    }
    // Add dislike extraction similarly if needed
  };

  return (
    <View style={styles.container}>
      {downloadProgress && (
        <View style={styles.progressContainer}>
          <Text>
            Downloading {downloadProgress.model}: {downloadProgress.percent.toFixed(0)}%
          </Text>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${downloadProgress.percent}%` },
              ]}
            />
          </View>
        </View>
      )}

      <FlatList
        data={messages}
        keyExtractor={(item, index) => index.toString()}
        renderItem={({ item }) => (
          <View
            style={[
              styles.message,
              item.role === 'user' ? styles.userMessage : styles.assistantMessage,
            ]}>
            <Text>{item.content}</Text>
          </View>
        )}
      />

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Type a message..."
          editable={modelsReady && !isLoading}
        />
        <Button
          title="Send"
          onPress={sendMessage}
          disabled={!modelsReady || isLoading}
        />
      </View>

      {isLoading && <ActivityIndicator size="large" />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  progressContainer: { flex: 1, marginBottom: 10, alignItems: 'center' ,justifyContent: 'center'},
  progressBar: { height: 10, backgroundColor: '#ccc', borderRadius: 5 },
  progressFill: { height: '100%', backgroundColor: '#007AFF', borderRadius: 5 },
  message: { padding: 10, marginVertical: 5, borderRadius: 8, maxWidth: '80%' },
  userMessage: { alignSelf: 'flex-end', backgroundColor: '#DCF8C6' },
  assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#ECECEC' },
  inputContainer: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, marginRight: 10 },
});