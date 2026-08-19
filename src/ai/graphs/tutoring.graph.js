const { StateGraph, END } = require('@langchain/langgraph');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const config = require('../../config/env');

const MAX_QUESTIONS = 6;

// -------------------------------------------------------------------
// LLM Instances
// -------------------------------------------------------------------
const llm = new ChatGoogleGenerativeAI({
  model: 'gemini-3.5-flash-lite',
  temperature: 0.4,
  apiKey: config.gemini.apiKey,
});

// -------------------------------------------------------------------
// Helper: Format history for prompt
// -------------------------------------------------------------------
const formatHistory = (history) => {
  if (!history || history.length === 0) return 'No prior conversation.';
  return history.map(m => `${m.role === 'ai' ? 'Tutor' : 'Student'}: ${m.content}`).join('\n');
};

// -------------------------------------------------------------------
// NODE 1: Retrieve study material (RAG)
// -------------------------------------------------------------------
const retrieveMaterialNode = async (state) => {
  console.log('--- TUTOR NODE: RETRIEVE MATERIAL ---');
  const retriever = new PGVectorRetriever({ userId: state.userId, topK: 8 });
  const docs = await retriever.invoke(`${state.subject} ${state.topic} key concepts definitions`);
  const studyContext = docs.map(d => `[${d.metadata.title}]: ${d.pageContent}`).join('\n\n');
  return { studyContext };
};

// -------------------------------------------------------------------
// NODE 2: Explain concept + ask opening question (used for START)
// -------------------------------------------------------------------
const explainAndAskNode = async (state) => {
  console.log('--- TUTOR NODE: EXPLAIN & ASK ---');
  const prompt = `You are a friendly, encouraging AI tutor teaching a student about "${state.topic}" in ${state.subject}.

STUDY MATERIAL:
${state.studyContext}

CONVERSATION HISTORY:
${formatHistory(state.conversationHistory)}

CURRENT CONCEPT: ${state.currentConcept || 'Introduction'}

Your task:
1. Explain the current concept clearly and concisely (2-3 sentences).
2. Ask ONE specific, targeted question to check the student's understanding.

Format your response as:
EXPLANATION: <your explanation>
QUESTION: <your question>`;

  const response = await llm.invoke(prompt);
  const text = response.content;

  // Parse explanation and question from response
  const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*?)(?=QUESTION:|$)/i);
  const questionMatch = text.match(/QUESTION:\s*([\s\S]*?)$/i);
  const explanation = explanationMatch ? explanationMatch[1].trim() : text;
  const question = questionMatch ? questionMatch[1].trim() : 'What did you understand from this?';

  const aiMessage = `${explanation}\n\n❓ ${question}`;
  const updatedHistory = [
    ...(state.conversationHistory || []),
    { role: 'ai', content: aiMessage }
  ];

  return {
    aiMessage,
    conversationHistory: updatedHistory,
    currentConcept: state.currentConcept || `Introduction to ${state.topic}`,
  };
};

// -------------------------------------------------------------------
// NODE 3: Evaluate student's answer
// -------------------------------------------------------------------
const evaluateStudentNode = async (state) => {
  console.log('--- TUTOR NODE: EVALUATE STUDENT ---');
  const prompt = `You are an AI tutor evaluating a student's answer.

TOPIC: ${state.topic}
CURRENT CONCEPT: ${state.currentConcept}
CONVERSATION HISTORY:
${formatHistory(state.conversationHistory)}

STUDENT'S ANSWER: "${state.studentAnswer}"

Evaluate the answer. Respond with ONLY a JSON object:
{
  "evaluation": "strong" or "weak",
  "feedback": "<brief encouraging feedback on their answer>",
  "weakArea": "<if weak, what specific part they didn't understand, else empty string>"
}`;

  const response = await llm.invoke(prompt);
  let text = response.content.trim();
  // Strip potential markdown code fences
  text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();

  let evaluation, feedback, weakArea;
  try {
    const parsed = JSON.parse(text);
    evaluation = parsed.evaluation || 'weak';
    feedback = parsed.feedback || 'Good effort!';
    weakArea = parsed.weakArea || '';
  } catch {
    evaluation = 'weak';
    feedback = 'Good effort! Let me explain that again.';
    weakArea = state.currentConcept;
  }

  const updatedHistory = [
    ...state.conversationHistory,
    { role: 'student', content: state.studentAnswer },
    { role: 'ai', content: feedback }
  ];

  const updatedWeakAreas = evaluation === 'weak' && weakArea
    ? [...(state.weakAreas || []), weakArea]
    : (state.weakAreas || []);

  return {
    evaluation,
    feedback,
    conversationHistory: updatedHistory,
    weakAreas: updatedWeakAreas,
  };
};

// -------------------------------------------------------------------
// NODE 4A: Re-explain (when student is weak)
// -------------------------------------------------------------------
const explainAgainNode = async (state) => {
  console.log('--- TUTOR NODE: EXPLAIN AGAIN (weak) ---');
  const prompt = `You are a patient AI tutor. The student struggled with: "${state.currentConcept}".

STUDY MATERIAL:
${state.studyContext}

Re-explain this concept using a different, simpler approach or a real-world analogy.
Then ask a simpler version of the question.

Format:
EXPLANATION: <simpler explanation>
QUESTION: <simpler question>`;

  const response = await llm.invoke(prompt);
  const text = response.content;
  const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*?)(?=QUESTION:|$)/i);
  const questionMatch = text.match(/QUESTION:\s*([\s\S]*?)$/i);
  const explanation = explanationMatch ? explanationMatch[1].trim() : text;
  const question = questionMatch ? questionMatch[1].trim() : 'Can you try to explain it in your own words?';

  const aiMessage = `Let me try explaining that differently!\n\n${explanation}\n\n❓ ${question}`;
  const updatedHistory = [...state.conversationHistory, { role: 'ai', content: aiMessage }];
  return { aiMessage, conversationHistory: updatedHistory };
};

// -------------------------------------------------------------------
// NODE 4B: Advance to harder concept (when student is strong)
// -------------------------------------------------------------------
const advanceConceptNode = async (state) => {
  console.log('--- TUTOR NODE: ADVANCE CONCEPT (strong) ---');
  const prompt = `You are an AI tutor. The student understood "${state.currentConcept}" well.

TOPIC: ${state.topic}
STUDY MATERIAL:
${state.studyContext}
CONVERSATION HISTORY:
${formatHistory(state.conversationHistory)}

Move to the NEXT concept in "${state.topic}". Explain it at a slightly harder level.
Then ask a challenging question.

Format:
CONCEPT: <name of the new concept>
EXPLANATION: <harder explanation>
QUESTION: <challenging question>`;

  const response = await llm.invoke(prompt);
  const text = response.content;
  const conceptMatch = text.match(/CONCEPT:\s*(.*)/i);
  const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*?)(?=QUESTION:|$)/i);
  const questionMatch = text.match(/QUESTION:\s*([\s\S]*?)$/i);

  const newConcept = conceptMatch ? conceptMatch[1].trim() : state.currentConcept;
  const explanation = explanationMatch ? explanationMatch[1].trim() : text;
  const question = questionMatch ? questionMatch[1].trim() : 'Can you explain this concept?';

  const aiMessage = `Great work! Let's move on to: **${newConcept}**\n\n${explanation}\n\n❓ ${question}`;
  const updatedHistory = [...state.conversationHistory, { role: 'ai', content: aiMessage }];

  return {
    aiMessage,
    conversationHistory: updatedHistory,
    currentConcept: newConcept,
  };
};

// -------------------------------------------------------------------
// NODE 5: Check if session should end
// -------------------------------------------------------------------
const checkEndNode = (state) => {
  const newCount = (state.questionCount || 0) + 1;
  if (newCount >= MAX_QUESTIONS) {
    return { questionCount: newCount, nextAction: 'end' };
  }
  return { questionCount: newCount, nextAction: 'continue' };
};

// -------------------------------------------------------------------
// NODE 6: Generate session summary (end of session)
// -------------------------------------------------------------------
const generateSummaryNode = async (state) => {
  console.log('--- TUTOR NODE: GENERATE SUMMARY ---');
  const weakAreasSummary = state.weakAreas && state.weakAreas.length > 0
    ? `Areas to review: ${state.weakAreas.join(', ')}`
    : 'Great job! No significant weak areas identified.';

  const aiMessage = `🎉 **Session Complete!**

You've completed your tutoring session on **${state.topic}**.

📊 **Summary:**
- Questions answered: ${state.questionCount}
- ${weakAreasSummary}

Keep up the great work! Consider uploading more notes to deepen your understanding.`;

  return { aiMessage, sessionStatus: 'COMPLETED' };
};

// -------------------------------------------------------------------
// BUILD GRAPH 1: Start Session Graph
// -------------------------------------------------------------------
const buildStartGraph = () => {
  const graph = new StateGraph({
    channels: {
      userId: { value: (a, b) => b ?? a },
      subject: { value: (a, b) => b ?? a },
      topic: { value: (a, b) => b ?? a },
      currentConcept: { value: (a, b) => b ?? a },
      conversationHistory: { value: (a, b) => b ?? a, default: () => [] },
      weakAreas: { value: (a, b) => b ?? a, default: () => [] },
      questionCount: { value: (a, b) => b ?? a, default: () => 0 },
      studyContext: { value: (a, b) => b ?? a, default: () => '' },
      aiMessage: { value: (a, b) => b ?? a, default: () => '' },
      studentAnswer: { value: (a, b) => b ?? a, default: () => '' },
      evaluation: { value: (a, b) => b ?? a, default: () => '' },
      feedback: { value: (a, b) => b ?? a, default: () => '' },
      nextAction: { value: (a, b) => b ?? a, default: () => 'continue' },
      sessionStatus: { value: (a, b) => b ?? a, default: () => 'ACTIVE' },
    }
  });

  graph.addNode('retrieveMaterial', retrieveMaterialNode);
  graph.addNode('explainAndAsk', explainAndAskNode);

  graph.setEntryPoint('retrieveMaterial');
  graph.addEdge('retrieveMaterial', 'explainAndAsk');
  graph.addEdge('explainAndAsk', END);

  return graph.compile();
};

// -------------------------------------------------------------------
// BUILD GRAPH 2: Respond Graph (each time student sends an answer)
// -------------------------------------------------------------------
const buildRespondGraph = () => {
  const graph = new StateGraph({
    channels: {
      userId: { value: (a, b) => b ?? a },
      subject: { value: (a, b) => b ?? a },
      topic: { value: (a, b) => b ?? a },
      currentConcept: { value: (a, b) => b ?? a },
      conversationHistory: { value: (a, b) => b ?? a, default: () => [] },
      weakAreas: { value: (a, b) => b ?? a, default: () => [] },
      questionCount: { value: (a, b) => b ?? a, default: () => 0 },
      studyContext: { value: (a, b) => b ?? a, default: () => '' },
      aiMessage: { value: (a, b) => b ?? a, default: () => '' },
      studentAnswer: { value: (a, b) => b ?? a },
      evaluation: { value: (a, b) => b ?? a, default: () => '' },
      feedback: { value: (a, b) => b ?? a, default: () => '' },
      nextAction: { value: (a, b) => b ?? a, default: () => 'continue' },
      sessionStatus: { value: (a, b) => b ?? a, default: () => 'ACTIVE' },
    }
  });

  graph.addNode('retrieveMaterial', retrieveMaterialNode);
  graph.addNode('evaluateStudent', evaluateStudentNode);
  graph.addNode('explainAgain', explainAgainNode);
  graph.addNode('advanceConcept', advanceConceptNode);
  graph.addNode('checkEnd', checkEndNode);
  graph.addNode('generateSummary', generateSummaryNode);

  graph.setEntryPoint('retrieveMaterial');
  graph.addEdge('retrieveMaterial', 'evaluateStudent');

  // Conditional: weak or strong?
  graph.addConditionalEdges('evaluateStudent', (state) => state.evaluation, {
    weak: 'explainAgain',
    strong: 'advanceConcept',
  });

  graph.addEdge('explainAgain', 'checkEnd');
  graph.addEdge('advanceConcept', 'checkEnd');

  // Conditional: end or continue?
  graph.addConditionalEdges('checkEnd', (state) => state.nextAction, {
    end: 'generateSummary',
    continue: END,
  });

  graph.addEdge('generateSummary', END);

  return graph.compile();
};

module.exports = { buildStartGraph, buildRespondGraph };
