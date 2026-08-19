const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
require('dotenv').config();

try {
  const llm = new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: 'gemini-1.5-flash',
  });
  console.log("Success");
} catch (e) {
  console.error(e);
}
