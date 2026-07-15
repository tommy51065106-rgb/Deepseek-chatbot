import React from 'react';
import { StyleSheet, View, StatusBar } from 'react-native';
import { Provider as PaperProvider } from 'react-native-paper';
import ChatScreen from './components/ChatScreen';

export default function App() {
  return (
    <PaperProvider>
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <ChatScreen />
      </View>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});