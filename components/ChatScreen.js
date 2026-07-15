import React, { useState, useRef, useEffect } from 'react';
import { 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  FlatList, 
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert
} from 'react-native';
import { Card, IconButton, Button } from 'react-native-paper';
import axios from 'axios';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

const RAG_BACKEND_URL = Platform.select({
  android: 'http://10.0.2.2:3000',
  ios: 'http://localhost:3000',
  default: 'http://localhost:3000',
});

const ChatScreen = () => {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [txtData, setTxtData] = useState('');
  const [isFileUploaded, setIsFileUploaded] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const flatListRef = useRef(null);

  const clearMemory = async () => {
    try {
      await axios.delete(`${RAG_BACKEND_URL}/memory`, { timeout: 5000 });
      setMessages([]);
    } catch (error) {
      console.error('Error clearing memory:', error?.response?.data || error.message);
    }
  };

  const sendMessage = async () => {
    if (inputText.trim() === '') return;

    const userMessage = {
      id: Date.now(),
      text: inputText,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString(),
    };
    
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);
    
    try {
      const response = await axios.post(
        `${RAG_BACKEND_URL}/chat`,
        {
          query: inputText,
          uploadedContext: txtData,
        }
      );

      if (Array.isArray(response.data?.messages)) {
        setMessages(response.data.messages);
      } else {
        const aiMessage = {
          id: Date.now() + 1,
          text: response.data.reply,
          sender: 'ai',
          timestamp: new Date().toLocaleTimeString(),
        };

        setMessages(prev => [...prev, aiMessage]);
      }
    } catch (error) {
      console.error('Error calling chat backend:', error?.response?.data || error.message);
      
      const errorMessage = {
        id: Date.now() + 1,
        text: 'Sorry, I encountered an error. Please try again.',
        sender: 'ai',
        timestamp: new Date().toLocaleTimeString(),
      };
      
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const pickTxt = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'text/plain',
        copyToCacheDirectory: true,
      });

      console.log('DocumentPicker result:', result);

      if (result.canceled) {
        console.log('File picker cancelled');
        return;
      }

      if (result.assets && result.assets.length > 0) {
        const file = result.assets[0];
        console.log('Selected file URI:', file.uri);
        
        try {
          const fileObj = new File(file.uri);
          const textContent = await fileObj.text();
          
          console.log('File content length:', textContent.length);
          setTxtData(textContent);
          setUploadedFileName(file.name || 'Uploaded file');
          setIsFileUploaded(true);

          // Do not block the screen transition on backend/network availability.
          clearMemory();

          Alert.alert('Success', 'Text file loaded successfully!');
        } catch (readError) {
          console.error('Error reading file:', readError);
          Alert.alert('Error', 'Failed to read file: ' + readError.message);
        }
      } else {
        console.log('No file selected');
      }
    } catch (error) {
      console.error('DocumentPicker error:', error);
      Alert.alert('Error', 'Failed to pick file: ' + error.message);
    }
  };

  const clearTxtFile = () => {
    setTxtData('');
    setUploadedFileName('');
    setMessages([]);
    setInputText('');
    setIsFileUploaded(false);
    clearMemory();
    Alert.alert('Info', 'File cleared. Ready to upload a new one.');
  };

  const renderMessage = ({ item }) => {

    if (!item.text || item.text.trim().length === 0) {
    return null; // Don't render empty messages
  }
  
    const isUser = item.sender === 'user';
    
    return (
      <View style={[
        styles.messageContainer,
        isUser ? styles.userMessageContainer : styles.aiMessageContainer
      ]}>
        <Card style={[
          styles.messageCard,
          isUser ? styles.userMessageCard : styles.aiMessageCard
        ]}>
          <Card.Content style={styles.cardContent}>
            <Text style={styles.messageText}>{item.text}</Text>
            {/* <Text style={styles.timestamp}>{item.timestamp}</Text> */}
          </Card.Content>
        </Card>
      </View>
    );
  };

  useEffect(() => {
    if (messages.length > 0) {
      flatListRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages]);

  if (!isFileUploaded) {
    return (
      <View style={styles.uploadGateContainer}>
        <View style={styles.uploadGateCard}>
          <Text style={styles.uploadGateTitle}>Upload your knowledge file</Text>
          <Text style={styles.uploadGateDescription}>
            Start by selecting a text file. The chat will open after the file is loaded.
          </Text>
          <Button mode="contained" onPress={pickTxt} style={styles.uploadGateButton}>
            Upload Txt
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.chatHeader}>
        <View>
          <Text style={styles.chatHeaderTitle}>Knowledge file ready</Text>
          <Text style={styles.chatHeaderSubtitle}>{uploadedFileName}</Text>
        </View>
        <Button mode="outlined" onPress={clearTxtFile} compact>
          Change File
        </Button>
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={item => item.id.toString()}
        contentContainerStyle={styles.messagesList}
      />
      
      {isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color="#6200ee" />
          <Text style={styles.loadingText}>DeepSeek is thinking...</Text>
        </View>
      )}
      
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.inputContainer}
      >
        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Type your message..."
          multiline
        />
        <TouchableOpacity 
          style={styles.sendButton} 
          onPress={sendMessage}
          disabled={isLoading}
        >
          <IconButton icon="send" size={20} color="white" />
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5ff',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
  },
  uploadGateContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#f5f5f5ff',
  },
  uploadGateCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: 'white',
    borderRadius: 24,
    padding: 24,
    elevation: 3,
  },
  uploadGateTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  uploadGateDescription: {
    fontSize: 15,
    lineHeight: 22,
    color: '#4b5563',
    marginBottom: 20,
  },
  uploadGateButton: {
    borderRadius: 14,
  },
  chatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  chatHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  chatHeaderSubtitle: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 4,
  },
  messagesList: {
    padding: 10,
  },
  messageContainer: {
    marginVertical: 5,
  },
  userMessageContainer: {
    alignItems: 'flex-end',
  },
  aiMessageContainer: {
    alignItems: 'flex-start',
  },
  messageCard: {
    maxWidth: '80%',
  },
  userMessageCard: {
    backgroundColor: '#9c9ff5ff',
    
  },
  aiMessageCard: {
    backgroundColor: 'white',
  },
  cardContent: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    // Center content both horizontally and vertically
    justifyContent: 'center',
    alignItems: 'center',
  },
  messageText: {
    color: 'black',
    // textAlign: 'center',
    // textAlignVertical: 'center',
    includeFontPadding: false,
  },
  timestamp: {
    fontSize: 10,
    color: 'gray',
    marginTop: 5,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
  loadingText: {
    marginLeft: 10,
    color: 'gray',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#ccc',
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 20,
    paddingHorizontal: 15,
    paddingVertical: 10,
    marginRight: 10,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: '#8668fbff',
    borderRadius: 20,
    padding: 0,
  },
});

export default ChatScreen;