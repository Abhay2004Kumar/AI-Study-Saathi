const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  try {
    // There is no listModels in the new SDK easily available?
    // Let's just try to fetch a known model
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const result = await model.embedContent("Hello world");
    console.log("Success with text-embedding-004! Vector length:", result.embedding.values.length);
  } catch (error) {
    console.error("Error with text-embedding-004:", error.message);
  }
}
run();
