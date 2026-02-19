import AsyncStorage from '@react-native-async-storage/async-storage';

const MESSAGES_KEY = '@chat_messages';
const PREFERENCES_KEY = '@user_preferences';

export const storeMessage = async (message) => {
  const existing = await loadMessages();
  const updated = [...existing, message];
  await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(updated));
  return updated;
};

export const loadMessages = async () => {
  const data = await AsyncStorage.getItem(MESSAGES_KEY);
  return data ? JSON.parse(data) : [];
};

export const getUserPreferences = async () => {
  const data = await AsyncStorage.getItem(PREFERENCES_KEY);
  return data ? JSON.parse(data) : { likes: [], dislikes: [], topics: [] };
};

export const updateUserPreferences = async (newPrefs) => {
  await AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(newPrefs));
};