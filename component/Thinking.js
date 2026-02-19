import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Animated,
  Easing,
} from 'react-native';

// Thinking animation component
const ThinkingIndicator = ({ text }) => {
  const bounceAnim = useRef(new Animated.Value(0)).current;
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Create bouncing animation for all dots
    const createBounceAnimation = (dot, delay) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(dot, {
            toValue: -5,
            duration: 300,
            easing: Easing.bounce,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 300,
            easing: Easing.bounce,
            useNativeDriver: true,
          }),
        ]),
        { delay }
      );
    };

    // Start animations with different delays
    Animated.parallel([
      createBounceAnimation(dot1, 0),
      createBounceAnimation(dot2, 150),
      createBounceAnimation(dot3, 300),
    ]).start();

    // Cleanup
    return () => {
      dot1.stopAnimation();
      dot2.stopAnimation();
      dot3.stopAnimation();
    };
  }, []);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Text>{text}</Text>
      <View style={{ flexDirection: 'row', marginLeft: 5 }}>
        <Animated.Text
          style={{
            transform: [{ translateY: dot1 }],
            fontSize: 20,
            marginHorizontal: 1,
          }}
        >
          .
        </Animated.Text>
        <Animated.Text
          style={{
            transform: [{ translateY: dot2 }],
            fontSize: 20,
            marginHorizontal: 1,
          }}
        >
          .
        </Animated.Text>
        <Animated.Text
          style={{
            transform: [{ translateY: dot3 }],
            fontSize: 20,
            marginHorizontal: 1,
          }}
        >
          .
        </Animated.Text>
      </View>
    </View>
  );
};

export default ThinkingIndicator;
