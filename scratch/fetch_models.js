require('dotenv').config();

async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  const data = await res.json();
  
  if (data.models) {
    const embedModels = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
    console.log("Supported Generation Models:", embedModels.map(m => m.name));
  } else {
    console.log("Error:", data);
  }
}
run();
