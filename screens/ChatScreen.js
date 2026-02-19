import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert
} from 'react-native';
import { mlc, MLCEngine } from '@react-native-ai/mlc';
import { generateText,streamText } from 'ai';
import {
  storeMessage,
  loadMessages,
  updateUserPreferences,
  getUserPreferences,
} from '../utils/storage';
import * as Clipboard from 'expo-clipboard';
import { initEmbeddingModel, addMessageEmbedding, findSimilarMessages, unloadEmbeddingModel, getVectorStoreStats } from '../utils/vectorStore';
import { CONFIG } from '../utils/config';
import ThinkingIndicator from '../component/Thinking';

const LLM_MODEL_ID = 'Llama-3.2-3B-Instruct';   // main chat model

export default function ChatScreen() {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [modelsReady, setModelsReady] = useState(false);
  const llmModel = useRef(null);
  const flatListRef = useRef(null);
 const [showDownloadModal, setShowDownloadModal] = useState(false);
 const [isGenerating, setIsGenerating] = useState(false);
const [isThinking, setIsThinking] = useState(false);

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
   // LLM download with popup
  setDownloadProgress({ model: LLM_MODEL_ID, percent: 0 });
  llmModel.current = mlc.languageModel(LLM_MODEL_ID);
  await llmModel.current.download((event) => {
    console.log("event.percentage", event,isNaN(event.percentage), event.percentage !== NaN);
    if (!isNaN(event.percentage)) setShowDownloadModal(true);
    setDownloadProgress({ model: LLM_MODEL_ID, percent: event.percentage });
  });
  await llmModel.current.prepare();

  // Embedding model silent
  await initEmbeddingModel(); // No progress UI

  setDownloadProgress(null);
  setShowDownloadModal(false);
  setModelsReady(true);
    
    // Log stats
    const stats = getVectorStoreStats();
    console.log('Vector store stats:', stats);
  } catch (error) {
    setShowDownloadModal(false);
    console.error('Model initialization failed:', error);
  }
};

const loadHistory = async () => {
  const history = await loadMessages();
  setMessages(history);
  
  // Give React one render cycle to update FlatList layout
  setTimeout(() => {
    if (flatListRef.current) {
      flatListRef.current.scrollToEnd({ animated: false }); // no animation on initial load
    }
  }, 50);   // 0–100 ms is usually enough

  await initVectorStore();
};

const sendMessage = async () => {
if (!inputText.trim() || !modelsReady) return;

  const userMsg = { role: 'user', content: inputText, timestamp: Date.now() };
  setMessages((prev) => [...prev, userMsg]);
  await storeMessage(userMsg);   // ← safe to await here
  setInputText('');

  const assistantTimestamp = Date.now();
  setMessages((prev) => [...prev, {
    role: 'assistant',
    content: 'Thinking...',
    timestamp: assistantTimestamp,
    isThinking: true,
  }]);
  setIsGenerating(true);

  let assistantContent = '';   // ← we build the full text here

  try {
    await storeMessage(userMsg);
    await addMessageEmbedding(userMsg.content);
    const similar = await findSimilarMessages(userMsg.content, CONFIG.topKSimilar || 4);
    const similarContext = similar.length
      ? `Related past conversations:\n${similar.map(s => `• ${s}`).join('\n')}`
      : '';

    const prefs = await getUserPreferences();
    const prefsText = prefs.likes.length || prefs.dislikes.length
      ? `User preferences and memories: likes ${prefs.likes.join(', ')}, dislikes ${prefs.dislikes.join(', ')}. Behaviors: ${JSON.stringify(prefs.behaviors || {})}`
      : '';

    const systemPrompt = `${CONFIG.systemPrompt}\n${prefsText}\n${similarContext}`.trim();

   const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-5).map(m => ({ role: m.role, content: m.content })), // recent
      { role: 'user', content: userMsg.content },
    ];

    const { textStream } = await streamText({
      model: llmModel.current,
      messages: fullMessages,
      temperature: CONFIG.temperature,
      maxTokens: CONFIG.maxTokens,
    });

    let isFirstToken = true;

    for await (const textPart of textStream) {
      assistantContent += textPart;   // accumulate locally

      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        let newContent = assistantContent;

        if (isFirstToken) {
          newContent = textPart.trim();
          isFirstToken = false;
        }

        updated[lastIdx] = {
          ...updated[lastIdx],
          content: newContent,
          isThinking: false,
        };
        return updated;
      });
    }

    // Now save the COMPLETE assistant message
    const finalAssistantMsg = {
      role: 'assistant',
      content: assistantContent,
      timestamp: assistantTimestamp,
    };

    await storeMessage(finalAssistantMsg);
    await addMessageEmbedding(assistantContent);

    await updatePreferencesFromMessage(userMsg.content);
  } catch (error) {
    console.error('Generation failed:', error);
    // Optional: mark failed
    setMessages(prev => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      last.content = (last.content || '') + '\n[Generation failed]';
      return updated;
    });
  } finally {
    setIsGenerating(false);
  }
};

  const updatePreferencesFromMessage = async (text) => {
    const prefs = await getUserPreferences();
    const likeMatch = text.match(/i like (\w+)/i);
    if (likeMatch) {
      const item = likeMatch[1].toLowerCase();
      if (!prefs.likes.includes(item)) {
        prefs.likes.push(item);
      }
    }
    const dislikeMatch = text.match(/i dislike (\w+)/i);
if (dislikeMatch) {
  const item = dislikeMatch[1].toLowerCase();
  if (!prefs.dislikes.includes(item)) {
    prefs.dislikes.push(item);
  }
}
    const praiseMatch = text.match(/good job|well done/i);
if (praiseMatch) {
  prefs.behaviors.helpful = (prefs.behaviors.helpful || 0) + CONFIG.learningRate;
}
const correctionMatch = text.match(/wrong|bad/i);
if (correctionMatch) {
  prefs.behaviors.helpful = (prefs.behaviors.helpful || 0) - CONFIG.learningRate;
}
    await updateUserPreferences(prefs);

  };

  return (
    <KeyboardAvoidingView
  style={styles.container}
  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
  keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
>
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
<Modal
  visible={showDownloadModal}
  transparent={true}
  animationType="fade"
>
  <View style={styles.modalOverlay}>
    <View style={styles.modalContent}>
      <Text style={styles.modalTitle}>Downloading {downloadProgress?.model}</Text>
      <Text style={styles.modalPercent}>{downloadProgress?.percent.toFixed(0)}%</Text>
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${downloadProgress?.percent}%` }]} />
      </View>
    </View>
  </View>
</Modal>
      <FlatList
        ref={flatListRef}
        inverted={false}
        data={messages}
        keyExtractor={(item, index) => index.toString()}
        onContentSizeChange={() => {
    flatListRef.current?.scrollToEnd({ animated: true });
  }}
  onLayout={() => {
    // Also scroll when the list itself is measured (helps on first mount)
    flatListRef.current?.scrollToEnd({ animated: false });
  }}
renderItem={({ item, index }) => (
  <TouchableOpacity
    style={[
      styles.message,
      item.role === 'user' ? styles.userMessage : styles.assistantMessage,
    ]}
    onLongPress={async () => {
      await Clipboard.setStringAsync(item.content);
      Alert.alert('Copied to clipboard');
    }}
  >
    <View style={{ position: 'relative' }}>
      {item.isThinking ? (
        <ThinkingIndicator text={item.content} />
      ) : (
        <Text style={styles.messageText}>{item.content}</Text>
      )}
    </View>
    <Text style={styles.timestamp}>
      {new Date(item.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}
    </Text>
  </TouchableOpacity>
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
  title={isGenerating ? 'processing' : 'Send'}
  onPress={isGenerating ? () => Alert.alert('Processing...', 'Please wait while the model is generating a response.') : sendMessage}
  disabled={!modelsReady}
/>
      </View>

      {isLoading && <ActivityIndicator size="large" />}
    </View>
</KeyboardAvoidingView>

  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  progressContainer: { flex: 1, marginBottom: 10, alignItems: 'center' ,justifyContent: 'center'},
  progressBar: { height: 10, backgroundColor: '#ccc', borderRadius: 5 },
  progressFill: { height: '100%', backgroundColor: '#007AFF', borderRadius: 5 },
message: {
  padding: 12,
  marginVertical: 8,
  borderRadius: 20,
  maxWidth: '80%',
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.1,
  shadowRadius: 2,
  elevation: 1,
},
userMessage: { alignSelf: 'flex-end', backgroundColor: '#D1FADF' }, // Soft green
assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#E0F2FE' }, // Soft blue
messageText: { fontSize: 16, color: '#333' },
timestamp: { fontSize: 12, color: '#999', marginTop: 4, alignSelf: 'flex-end' },
inputContainer: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderColor: '#eee' },
input: { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 20, padding: 12, marginRight: 10, backgroundColor: '#fff' },
  modalOverlay: {
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: 'rgba(0,0,0,0.5)',
},
modalContent: {
  backgroundColor: '#fff',
  padding: 20,
  borderRadius: 16,
  width: '80%',
  alignItems: 'center',
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.25,
  shadowRadius: 4,
  elevation: 5,
},
modalTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
modalPercent: { fontSize: 16, marginBottom: 10 },
});