# AI Study Saathi - Backend Engine 🧠

The backend infrastructure powering **AI Study Saathi**, an intelligent, RAG-driven study companion. This service is built with **Node.js, Express, and Prisma**, leveraging **PostgreSQL (`pgvector`)** for semantic search, and the **LangChain / LangGraph** ecosystems for complex LLM orchestration.

## 🏗️ Architecture & RAG Pipeline

Our backend is built around a robust Retrieval-Augmented Generation (RAG) architecture. When a user uploads a study document (PDF/TXT), the following pipeline is executed:

1. **Ingestion & Chunking**: The document is parsed using `pdf-parse`, and split into semantically meaningful chunks using LangChain's `RecursiveCharacterTextSplitter`.
2. **Vectorization**: Each chunk is embedded using Google's `text-embedding-004` model.
3. **Storage**: Vectors and metadata are stored natively in our PostgreSQL database using the `pgvector` extension via Prisma's typed client.
4. **Retrieval**: When a feature is triggered, `PGVectorRetriever` performs a cosine-similarity search to pull the most relevant context chunks for the LLM.

---

## 🤖 Core AI Features

### 1. The Interactive AI Tutor (Powered by LangGraph)

<img src="./public/tutor.jpeg" alt="AI Live Tutor" width="300" style="border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 15px;" />

Unlike a standard stateless chatbot, the AI Tutor uses **LangGraph** to maintain a stateful, cyclical graph architecture. 
- **State Management**: It tracks `conversationHistory`, `currentConcept`, `questionCount`, and `weakAreas` in memory across graph nodes.
- **Dynamic Routing**: Depending on the user's answer, LangGraph dynamically routes the execution flow:
  - If the user understands the concept ➡️ Moves to the next concept.
  - If the user struggles ➡️ Routes to an "explain again" node using simpler terms.
- **RAG Integration**: Before starting, the tutor pulls dense context about the specific topic from the user's vector store to ensure highly accurate teaching.

---

### 2. Dynamic Quizzes (Powered by LangChain + Zod)

<img src="./public/quiz.jpeg" alt="AI Quiz Interface" width="300" style="border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 15px;" />

Our quiz generator doesn't just ask the LLM to "write some questions." It uses **LangChain's `StructuredOutputParser`** combined with **Zod Schemas** to enforce strict JSON structural integrity.
- **Randomization**: A mathematical seed is injected into the prompt template alongside a high temperature (`0.8`), forcing the LLM to retrieve a completely varied subset of facts from the `PGVectorRetriever` on every request.
- **Validation**: The Zod schema ensures the API strictly returns 5 questions, exactly 4 options per question, the correct answer, and an explanation. If the LLM breaks the schema, LangChain automatically attempts to parse and fix the output.

---

### 3. Smart Flashcards (Powered by RAG Context)

<img src="./public/flashcards.jpeg" alt="AI Flashcards" width="300" style="border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 15px;" />

The flashcard generator utilizes a LangChain `RunnableSequence` to pipe retrieved vector context into an optimized prompt template. 
- It extracts high-density definitions and key terms.
- It automatically generates contextual "hints" and cites the original source document for every card, proving the RAG pipeline's traceability.

---

### 4. Smart Dashboard (Document Processing)

<img src="./public/dashboard.jpeg" alt="AI Study Saathi Dashboard" width="300" style="border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 15px;" />

The dashboard serves as the central hub where users manage their study materials. Documents are processed asynchronously in the background, updating their status from `PROCESSING` to `READY` once the text extraction, chunking, and vector embedding pipelines are complete.

---

## 🚀 Getting Started (Local Development)

### Prerequisites
- Node.js (v18+)
- PostgreSQL database with the `pgvector` extension installed.
- Gemini API Key.

### Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Environment Variables:**
   Copy `.env.example` to `.env` and fill in your database credentials, JWT secret, and Gemini API key.
3. **Database Setup (Prisma):**
   ```bash
   npx prisma generate
   npx prisma db push
   ```
4. **Start the server:**
   ```bash
   npm run dev
   ```

---
*Built for modern education using cutting-edge AI orchestration.*
