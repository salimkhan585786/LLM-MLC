import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
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
  ActionSheetIOS,
  InteractionManager,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { mlc } from '@react-native-ai/mlc';
import { smoothStream, streamText } from 'ai';
import {
  storeMessage,
  loadMessages,
  getUserPreferences,
  addUserLike,
  addUserDislike,
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
import throttle from 'lodash.throttle';

const LLM_MODEL_ID = 'Llama-3.2-1B-Instruct';
const BATCH_SIZE = 20;

// Optimized MessageItem with useCallback for handlers
const MemoizedMessageItem = memo(({ item, onCopy, onAddToLikes, onAddToDislikes }) => {
  const handleLongPress = useCallback(() => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Copy', 'Add to Likes', 'Add to Dislikes'],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) onCopy();
          else if (buttonIndex === 2) onAddToLikes();
          else if (buttonIndex === 3) onAddToDislikes();
        }
      );
    } else {
      Alert.alert(
        'Message Options',
        'Choose an action',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Copy', onPress: onCopy },
          { text: 'Add to Likes', onPress: onAddToLikes },
          { text: 'Add to Dislikes', onPress: onAddToDislikes },
        ],
        { cancelable: true }
      );
    }
  }, [onCopy, onAddToLikes, onAddToDislikes]);

  // Memoize timestamp to prevent recalculation
  const formattedTime = useMemo(() => {
    return new Date(item.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [item.timestamp]);

  return (
    <TouchableOpacity
      style={[
        styles.message,
        item.role === 'user' ? styles.userMessage : styles.assistantMessage,
      ]}
      onLongPress={handleLongPress}
      activeOpacity={0.7}
      delayLongPress={500} // Add delay to prevent accidental triggers
    >
      <View style={{ position: 'relative' }}>
        {item.isThinking ? (
          <TypingDots text={item.content} />
        ) : (
          <Text style={styles.messageText}>{item.content}</Text>
        )}
      </View>
      <Text style={styles.timestamp}>{formattedTime}</Text>
    </TouchableOpacity>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  return prevProps.item.content === nextProps.item.content &&
    prevProps.item.isThinking === nextProps.item.isThinking &&
    prevProps.item.timestamp === nextProps.item.timestamp;
});

export default function ChatScreen() {
  // State declarations
  const [messages, setMessages] = useState([]);
  const [allMessages, setAllMessages] = useState([]);
  const [streamingAssistant, setStreamingAssistant] = useState(null);
  const [inputText, setInputText] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [modelsReady, setModelsReady] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // Refs for performance optimization
  const llmModel = useRef(null);
  const flatListRef = useRef(null);
  const isScrolledToBottom = useRef(true);
  const updateScheduledRef = useRef(false);
  const abortControllerRef = useRef(null);

  // Throttled scroll function
  const throttledScrollToBottom = useRef(
    throttle((animated) => {
      if (flatListRef.current && isScrolledToBottom.current) {
        flatListRef.current.scrollToEnd({ animated });
      }
    }, 100)
  ).current;

  useEffect(() => {
    const setup = async () => {
      try {
        // Use InteractionManager to run after animations complete
        InteractionManager.runAfterInteractions(async () => {
          await initializeModels();
          await loadHistory();
          setIsLoading(false);
        });
      } catch (e) {
        console.error(e);
        setIsLoading(false);
      }
    };

    setup();

    return () => {
      unloadEmbeddingModel();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const initializeModels = async () => {
    console.log('HIT Initializing LLM model:', LLM_MODEL_ID);
    try {
      setDownloadProgress({ model: LLM_MODEL_ID, percent: 0 });
      llmModel.current = mlc.languageModel(LLM_MODEL_ID);

      // Download with progress updates (throttled)
      await llmModel.current.download((event) => {
        if (!isNaN(event.percentage)) {
          // Throttle progress updates to reduce renders
          requestAnimationFrame(() => {
            setShowDownloadModal(true);
            setDownloadProgress({ model: LLM_MODEL_ID, percent: event.percentage });
          });
        }
      });

      // Prepare model in background
      await llmModel.current.prepare();

      // Initialize embedding model without blocking
      setTimeout(() => {
        initEmbeddingModel().catch(console.error);
      }, 100);

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
    console.log('HIT Loading message history');
    const history = await loadMessages();
    setAllMessages(history);
    const initialBatch = history.slice(-BATCH_SIZE);
    setMessages(initialBatch);
    setHasMoreMessages(history.length > BATCH_SIZE);

    // Use InteractionManager for scroll after navigation
    InteractionManager.runAfterInteractions(() => {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: false });
      }, 100);
    });
  };

  const loadMoreMessages = useCallback(() => {
    console.log('HIT Loading more messages');
    if (isLoadingMore || !hasMoreMessages) return;

    setIsLoadingMore(true);

    // Use requestIdleCallback for non-urgent loading
    const loadMore = () => {
      const currentLength = messages.length;
      const remaining = allMessages.length - currentLength;
      const nextBatchSize = Math.min(BATCH_SIZE, remaining);
      const nextBatch = allMessages.slice(
        allMessages.length - currentLength - nextBatchSize,
        allMessages.length - currentLength
      );

      // Batch state updates
      setMessages((prev) => [...nextBatch, ...prev]);
      setHasMoreMessages(nextBatchSize === BATCH_SIZE);
      setIsLoadingMore(false);
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadMore, { timeout: 1000 });
    } else {
      setTimeout(loadMore, 100);
    }
  }, [isLoadingMore, hasMoreMessages, messages.length, allMessages]);

  const scrollToBottom = useCallback((animated = true) => {
    // console.log('HIT Scrolling to bottom. Animated:', animated);
    throttledScrollToBottom(animated);
  }, [throttledScrollToBottom]);

  const handleScroll = useCallback(({ nativeEvent }) => {
    // console.log('HIT Handling scroll event');
    const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
    const paddingToBottom = 100;

    // Update scroll position ref without state
    isScrolledToBottom.current =
      layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom;

    // Throttled loading of more messages
    if (contentOffset.y <= 50 && hasMoreMessages && !isLoadingMore) {
      requestAnimationFrame(() => {
        loadMoreMessages();
      });
    }
  }, [hasMoreMessages, isLoadingMore, loadMoreMessages]);

  const handleAddToLikes = useCallback(async (content) => {
    console.log('HIT Adding message to likes:', content);
    try {
      await addUserLike(content);
      Alert.alert('Success', 'Added to your likes!');
    } catch (error) {
      Alert.alert('Error', 'Failed to add to likes');
    }
  }, []);

  const handleAddToDislikes = useCallback(async (content) => {
    console.log('HIT Adding message to dislikes:', content);
    try {
      await addUserDislike(content);
      Alert.alert('Success', 'Added to your dislikes!');
    } catch (error) {
      Alert.alert('Error', 'Failed to add to dislikes');
    }
  }, []);

  const handleCopy = useCallback(async (content) => {
    console.log('HIT Copying message content:', content);
    await Clipboard.setStringAsync(content);
  }, []);

  // Optimized sendMessage with performance improvements
  const sendMessage = useCallback(async () => {
    console.log('HIT Sending message:', inputText);
    if (!inputText.trim() || !modelsReady || isGenerating) return;

    // Cancel any ongoing generation
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Hide keyboard
    Keyboard.dismiss();

    const userMsg = {
      role: 'user',
      content: inputText,
      timestamp: Date.now()
    };

    // Batch state updates
    setInputText('');
    setMessages(prev => [...prev, userMsg]);
    setAllMessages(prev => [...prev, userMsg]);

    // Store message in background
    setTimeout(() => storeMessage(userMsg), 0);

    const assistantTimestamp = Date.now();
    setStreamingAssistant({
      role: 'assistant',
      content: '',
      timestamp: assistantTimestamp,
      isThinking: true,
    });
    setIsGenerating(true);

    let fullAssistantContent = '';
    const updateQueue = [];

    try {
      // Non-blocking embedding
      // setTimeout(() => {
      //   addMessageEmbedding(userMsg.content).catch(console.error);
      // }, 0);

      // Parallel execution where possible
      const [similar, prefs] = await Promise.all([
        findSimilarMessages(userMsg.content, CONFIG.topKSimilar || 4),
        getUserPreferences()
      ]);

      const similarContext = similar.length
        ? `Related past conversations (only highly relevant):\n${similar.map((s) => `• ${s}`).join('\n')}`
        : '';
      console.log('Similar messages found:', similar);
      const prefsText = prefs.likes.length || prefs.dislikes.length
        ? `User preferences and memories: likes ${prefs.likes.join(', ')}, dislikes ${prefs.dislikes.join(', ')}. Behaviors: ${JSON.stringify(prefs.behaviors || {})}`
        : '';

      const systemPrompt = `${CONFIG.systemPrompt}\n${prefsText}\n${similarContext}`.trim();

      const recentMessages = messages.slice(-3);
      console.log("System prompt constructed:", systemPrompt);
      console.log('Recent messages for context:', recentMessages);
      const fullMessages = [
        { role: 'system', content: systemPrompt },
        ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMsg.content },
      ];

      const totalChars = fullMessages.reduce((sum, m) => sum + m.content.length, 0);
      if (totalChars > 1200) {
        fullMessages.splice(1, 1);
      }
      console.log('Final messages sent to model:', fullMessages);
      const { textStream } = await streamText({
        model: llmModel.current,
        messages: fullMessages,
        temperature: CONFIG.temperature,
        maxTokens: CONFIG.maxTokens,
        experimental_transform: smoothStream({
          delayInMs: 60,
          chunking: 'word',
        }),
        abortSignal: abortControllerRef.current.signal,
      });

      // Optimized update scheduler
      const scheduleUpdate = () => {
        if (updateScheduledRef.current) return;
        updateScheduledRef.current = true;

        requestAnimationFrame(() => {
          if (updateQueue.length === 0) {
            updateScheduledRef.current = false;
            return;
          }

          const pendingContent = updateQueue.join('');
          updateQueue.length = 0;

          fullAssistantContent += pendingContent;

          // Batch state update
          setStreamingAssistant((prev) => ({
            ...prev,
            content: fullAssistantContent,
            isThinking: false,
          }));

          updateScheduledRef.current = false;
        });
      };

      // Collect chunks efficiently
      for await (const textPart of textStream) {
        if (abortControllerRef.current.signal.aborted) break;

        updateQueue.push(textPart);
        scheduleUpdate();
      }

      if (!abortControllerRef.current.signal.aborted) {
    
        // Final update
        const finalAssistantMsg = {
          role: 'assistant',
          content: fullAssistantContent,
          timestamp: assistantTimestamp,
        };

        // Parallel operations
          await Promise.all([
          storeMessage(finalAssistantMsg),
          addMessageEmbedding(userMsg.content).catch(() => { }),     // user message
          addMessageEmbedding(fullAssistantContent).catch(() => { }), // assistant reply
        ]);

        // Batch final state updates
        setAllMessages(prev => [...prev, finalAssistantMsg]);
        setMessages(prev => [...prev, finalAssistantMsg]);
        setStreamingAssistant(null);
        scrollToBottom(true);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Generation aborted');
      } else {
        console.error('Generation failed:', error);
        setStreamingAssistant(prev =>
          prev && { ...prev, content: prev.content + '\n[Generation failed]' }
        );
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  }, [inputText, modelsReady, isGenerating, messages, scrollToBottom]);

  // Memoized render functions
  const renderMessageItem = useCallback(({ item }) => (
    <MemoizedMessageItem
      item={item}
      onCopy={() => handleCopy(item.content)}
      onAddToLikes={() => handleAddToLikes(item.content)}
      onAddToDislikes={() => handleAddToDislikes(item.content)}
    />
  ), [handleCopy, handleAddToLikes, handleAddToDislikes]);

  const renderHeader = useCallback(() => (
    isLoadingMore ? <ActivityIndicator size="small" color="#007AFF" style={styles.loader} /> : null
  ), [isLoadingMore]);

  const renderFooter = useCallback(() => (
    streamingAssistant && (
      <MemoizedMessageItem
        item={streamingAssistant}
        onCopy={() => handleCopy(streamingAssistant.content)}
        onAddToLikes={() => handleAddToLikes(streamingAssistant.content)}
        onAddToDislikes={() => handleAddToDislikes(streamingAssistant.content)}
      />
    )
  ), [streamingAssistant, handleCopy, handleAddToLikes, handleAddToDislikes]);

  // Memoized content size change handler
  const handleContentSizeChange = useCallback(() => {
    if (!isGenerating) {
      scrollToBottom(false);
    }
  }, [isGenerating, scrollToBottom]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
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
          renderItem={renderMessageItem}
          keyExtractor={(item, index) => `msg-${item.timestamp}-${index}`}
          estimatedItemSize={100}
          ListHeaderComponent={renderHeader}
          ListFooterComponent={renderFooter}
          onScroll={handleScroll}
          onContentSizeChange={handleContentSizeChange}
          onLayout={() => scrollToBottom(false)}
          windowSize={5} // Reduced from 7
          initialNumToRender={10} // Reduced from 12
          maxToRenderPerBatch={5} // Reduced from 6
          removeClippedSubviews={Platform.OS === 'android'}
          contentContainerStyle={styles.flatListContent}
          maintainVisibleContentPosition={{
            minIndexForVisible: 0,
          }}
          scrollEventThrottle={16} // Optimize scroll events
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
            blurOnSubmit={false}
            onSubmitEditing={() => {
              if (inputText.trim() && !isGenerating) {
                sendMessage();
              }
            }}
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!modelsReady || isGenerating) && styles.disabledButton
            ]}
            onPress={isGenerating ? null : sendMessage}
            disabled={!modelsReady || isGenerating}
            activeOpacity={0.7}
          >
            <Text style={styles.sendButtonText}>
              {isGenerating ? '⏳' : '➤'}
            </Text>
          </TouchableOpacity>
        </View>

        {isLoading && (
          <ActivityIndicator
            size="large"
            color="#007AFF"
            style={styles.globalLoader}
          />
        )}
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