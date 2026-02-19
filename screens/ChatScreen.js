import React, { useState, useEffect, useRef, memo } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Keyboard,
} from 'react-native';
import { FlashList } from '@shopify/flash-list'; // expo install @shopify/flash-list
import { mlc } from '@react-native-ai/mlc';
import { streamText } from 'ai';
import {
  storeMessage,
  loadMessages,
  updateUserPreferences,
  getUserPreferences,
} from '../utils/storage';
import * as Clipboard from 'expo-clipboard';
import {
  initEmbeddingModel,
  addMessageEmbedding,
  findSimilarMessages,
  unloadEmbeddingModel,
  getVectorStoreStats,
} from '../utils/vectorStore';
import { CONFIG } from '../utils/config';
import { TypingDots } from '../component/Thinking';
import throttle from 'lodash.throttle'; // expo install lodash.throttle

const LLM_MODEL_ID = 'Llama-3.2-3B-Instruct';
const BATCH_SIZE = 20;

const MemoizedMessageItem = memo(({ item, onCopy }) => (
  <TouchableOpacity
    style={[
      styles.message,
      item.role === 'user' ? styles.userMessage : styles.assistantMessage,
    ]}
    onLongPress={onCopy}
    activeOpacity={0.7}
  >
    <View style={{ position: 'relative' }}>
      {item.isThinking ? (
        <TypingDots text={item.content} />
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
));

export default function ChatScreen() {
  const [messages, setMessages] = useState([]); // Visible paginated messages
  const [allMessages, setAllMessages] = useState([]); // Full history
  const [streamingAssistant, setStreamingAssistant] = useState(null); // Active typing message
  const [inputText, setInputText] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const llmModel = useRef(null);
  const flatListRef = useRef(null);
  const isFirstTokenRef = useRef(true);
  const isScrolledToBottom = useRef(true);

  useEffect(() => {
    const setup = async () => {
      try {
        await initializeModels();
        await loadHistory();
      } catch (e) {
        console.error(e);
      } finally {
        setIsLoading(false);
      }
    };

    setup();

    return () => {
      unloadEmbeddingModel();
    };
  }, []);

  const initializeModels = async () => {
    try {
      setDownloadProgress({ model: LLM_MODEL_ID, percent: 0 });
      llmModel.current = mlc.languageModel(LLM_MODEL_ID);
      await llmModel.current.download((event) => {
        if (!isNaN(event.percentage)) {
          setShowDownloadModal(true);
          setDownloadProgress({ model: LLM_MODEL_ID, percent: event.percentage });
        }
      });
      await llmModel.current.prepare();

      await initEmbeddingModel(); // Silent

      setDownloadProgress(null);
      setShowDownloadModal(false);
      setModelsReady(true);

      const stats = getVectorStoreStats();
      console.log('Vector store stats:', stats);
    } catch (error) {
      setShowDownloadModal(false);
      console.error('Model initialization failed:', error);
    }
  };

  const loadHistory = async () => {
    const history = await loadMessages();
    setAllMessages(history);
    const initialBatch = history.slice(-BATCH_SIZE);
    setMessages(initialBatch);
    setHasMoreMessages(history.length > BATCH_SIZE);

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: false });
    }, 100);
  };

  const loadMoreMessages = () => {
    if (isLoadingMore || !hasMoreMessages) return;
    setIsLoadingMore(true);

    setTimeout(() => {
      const currentLength = messages.length;
      const remaining = allMessages.length - currentLength;
      const nextBatchSize = Math.min(BATCH_SIZE, remaining);
      const nextBatch = allMessages.slice(
        allMessages.length - currentLength - nextBatchSize,
        allMessages.length - currentLength
      );

      setMessages((prev) => [...nextBatch, ...prev]);
      setHasMoreMessages(nextBatchSize === BATCH_SIZE);
      setIsLoadingMore(false);
    }, 300);
  };

  const scrollToBottom = (animated = true) => {
    if (flatListRef.current && isScrolledToBottom.current) {
      flatListRef.current.scrollToEnd({ animated });
    }
  };

  const handleScroll = ({ nativeEvent }) => {
    // Check if user is scrolled near the bottom
    const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
    const paddingToBottom = 100;
    isScrolledToBottom.current = 
      layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;

    // Load more messages when scrolling up
    if (contentOffset.y <= 50 && hasMoreMessages && !isLoadingMore) {
      loadMoreMessages();
    }
  };

  const sendMessage = async () => {
    if (!inputText.trim() || !modelsReady) return;

    // Hide keyboard
    Keyboard.dismiss();

    const userMsg = { role: 'user', content: inputText, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setAllMessages((prev) => [...prev, userMsg]);
    await storeMessage(userMsg);
    setInputText('');

    const assistantTimestamp = Date.now();
    setStreamingAssistant({
      role: 'assistant',
      content: 'Thinking...',
      timestamp: assistantTimestamp,
      isThinking: true,
    });
    setIsGenerating(true);

    let assistantContent = '';
    isFirstTokenRef.current = true;

    try {
      await addMessageEmbedding(userMsg.content);
      const similar = await findSimilarMessages(userMsg.content, CONFIG.topKSimilar || 4);
      const similarContext = similar.length
        ? `Related past conversations (only highly relevant):\n${similar.map((s) => `• ${s}`).join('\n')}`
        : '';

      const prefs = await getUserPreferences();
      const prefsText = prefs.likes.length || prefs.dislikes.length
        ? `User preferences and memories: likes ${prefs.likes.join(', ')}, dislikes ${prefs.dislikes.join(', ')}. Behaviors: ${JSON.stringify(
            prefs.behaviors || {}
          )}`
        : '';

      const systemPrompt = `${CONFIG.systemPrompt}\n${prefsText}\n${similarContext}`.trim();

      const recentMessages = messages.slice(-3);
      const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMsg.content },
      ];

      const totalChars = fullMessages.reduce((sum, m) => sum + m.content.length, 0);
      if (totalChars > 1200) {
        fullMessages.splice(1, 1);
      }

      const { textStream } = await streamText({
        model: llmModel.current,
        messages: fullMessages,
        temperature: CONFIG.temperature,
        maxTokens: CONFIG.maxTokens,
      });

      const updateThrottled = throttle((chunk) => {
        setStreamingAssistant((prev) => {
          if (!prev) return prev;
          let newContent = (prev.content || '') + chunk;
          if (isFirstTokenRef.current) {
            newContent = chunk.trim();
            isFirstTokenRef.current = false;
          }
          return { ...prev, content: newContent, isThinking: false };
        });
        // Auto-scroll during generation
        scrollToBottom(true);
      }, 80);

      for await (const textPart of textStream) {
        assistantContent += textPart;
        updateThrottled(textPart);
      }
      updateThrottled.flush();

      const finalAssistantMsg = {
        role: 'assistant',
        content: assistantContent,
        timestamp: assistantTimestamp,
      };

      await storeMessage(finalAssistantMsg);
      addMessageEmbedding(assistantContent); // fire-and-forget
      setAllMessages((prev) => [...prev, finalAssistantMsg]);

      setMessages((prev) => [...prev, finalAssistantMsg]);
      setStreamingAssistant(null);
      
      // Scroll to bottom after message is complete
      scrollToBottom(true);
    } catch (error) {
      console.error('Generation failed:', error);
      setStreamingAssistant((prev) => prev && { ...prev, content: (prev.content || '') + '\n[Generation failed]' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (content) => {
    await Clipboard.setStringAsync(content);
    Alert.alert('Copied to clipboard');
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
    >
      <View style={styles.container}>
        <Modal visible={showDownloadModal} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Downloading Model</Text>
              <Text style={styles.modalPercent}>{downloadProgress?.percent.toFixed(0)}%</Text>
              <View style={styles.progressBar}>
                <View style={[styles.progressFill, { width: `${downloadProgress?.percent}%` }]} />
              </View>
            </View>
          </View>
        </Modal>

        <FlashList
          ref={flatListRef}
          data={messages}
          renderItem={({ item }) => (
            <MemoizedMessageItem item={item} onCopy={() => handleCopy(item.content)} />
          )}
          keyExtractor={(item, index) => index.toString()}
          estimatedItemSize={100}
          ListHeaderComponent={
            isLoadingMore ? <ActivityIndicator size="small" color="#007AFF" style={styles.loader} /> : null
          }
          ListFooterComponent={
            streamingAssistant && (
              <MemoizedMessageItem
                item={streamingAssistant}
                onCopy={() => handleCopy(streamingAssistant.content)}
              />
            )
          }
          onScroll={handleScroll}
          onContentSizeChange={() => {
            // Scroll to bottom when content size changes and user is at bottom
            scrollToBottom(!isGenerating);
          }}
          onLayout={() => {
            // Scroll to bottom on initial layout
            scrollToBottom(false);
          }}
          windowSize={7}
          initialNumToRender={12}
          maxToRenderPerBatch={6}
          removeClippedSubviews={Platform.OS === 'android'}
          contentContainerStyle={styles.flatListContent}
        />

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Type a message..."
            placeholderTextColor="#999"
            editable={modelsReady && !isLoading}
            multiline
            maxLength={500}
            blurOnSubmit={false} // Prevents keyboard from closing on submit
            onSubmitEditing={() => {
              if (inputText.trim()) {
                sendMessage();
              }
            }}
          />
          <TouchableOpacity
            style={[styles.sendButton, !modelsReady && styles.disabledButton]}
            onPress={isGenerating ? () => Alert.alert('Processing...', 'Please wait...') : sendMessage}
            disabled={!modelsReady}
            activeOpacity={0.7}
          >
            <Text style={styles.sendButtonText}>{isGenerating ? '⏳' : '➤'}</Text>
          </TouchableOpacity>
        </View>

        {isLoading && <ActivityIndicator size="large" color="#007AFF" style={styles.globalLoader} />}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA' },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  modalContent: {
    backgroundColor: '#FFF',
    padding: 28,
    borderRadius: 24,
    width: '82%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 12,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#222', marginBottom: 14 },
  modalPercent: { fontSize: 22, fontWeight: 'bold', color: '#007AFF', marginBottom: 16 },
  progressBar: { height: 10, width: '90%', backgroundColor: '#E9ECEF', borderRadius: 5 },
  progressFill: { height: '100%', backgroundColor: '#007AFF', borderRadius: 5 },
  message: {
    padding: 14,
    marginVertical: 6,
    borderRadius: 22,
    maxWidth: '78%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
  },
  userMessage: { alignSelf: 'flex-end', backgroundColor: '#D1FADF' },
  assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EDEDED' },
  messageText: { fontSize: 16, color: '#1A1A1A', lineHeight: 22 },
  timestamp: { fontSize: 11, color: '#8A8A8A', marginTop: 6, alignSelf: 'flex-end' },
  flatListContent: { paddingHorizontal: 12, paddingBottom: 80 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#E9ECEF',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 24,
    padding: 12,
    paddingHorizontal: 18,
    marginRight: 12,
    backgroundColor: '#F9FAFB',
    fontSize: 16,
    maxHeight: 120,
    minHeight: 48,
  },
  sendButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 6,
  },
  disabledButton: { backgroundColor: '#A0C4FF' },
  sendButtonText: { fontSize: 26, color: '#FFFFFF', fontWeight: 'bold' },
  loader: { marginVertical: 20 },
  globalLoader: { position: 'absolute', bottom: 100, alignSelf: 'center' },
});