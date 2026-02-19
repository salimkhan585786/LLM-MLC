import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Animated,
  Easing,
  StyleSheet,
} from 'react-native';

export const TypingDots = ({ text }) => {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const createWaveAnimation = (dot, delay) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };

    Animated.parallel([
      createWaveAnimation(dot1, 0),
      createWaveAnimation(dot2, 133),
      createWaveAnimation(dot3, 266),
    ]).start();

    return () => {
      dot1.stopAnimation();
      dot2.stopAnimation();
      dot3.stopAnimation();
    };
  }, []);

  const getDotStyle = (anim) => ({
    opacity: anim,
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -5],
        }),
      },
    ],
  });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text style={styles.messageText}>{text}</Text>
      <View style={{ flexDirection: 'row', marginLeft: 8 }}>
        <Animated.Text style={[styles.typingDot, getDotStyle(dot1)]}>•</Animated.Text>
        <Animated.Text style={[styles.typingDot, getDotStyle(dot2)]}>•</Animated.Text>
        <Animated.Text style={[styles.typingDot, getDotStyle(dot3)]}>•</Animated.Text>
      </View>
    </View>
  );
};

// Add to your styles:
const styles = StyleSheet.create({
  // ... existing styles
  typingDot: {
    fontSize: 24,
    color: '#666',
    marginHorizontal: 2,
  },
});
