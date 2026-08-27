const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const examRoutes = require('./routes/exam.routes');
const documentRoutes = require('./routes/document.routes');
const aiRoutes = require('./routes/ai.routes');
const quizRoutes = require('./routes/quiz.routes');
const flashcardRoutes = require('./routes/flashcard.routes');
const tutoringRoutes = require('./routes/tutoring.routes');
const mappingRoutes = require('./routes/mapping.routes');
const pyqQuestionRoutes = require('./routes/pyqQuestion.routes');
const studyPlanSessionRoutes = require('./routes/studyPlanSession.routes');
const { errorHandler, notFoundHandler } = require('./middleware/error.middleware');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(morgan('dev'));

// Serve uploaded files statically (optional, but good for testing downloads)
app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/flashcards', flashcardRoutes);
app.use('/api/tutoring', tutoringRoutes);
app.use('/api/mappings', mappingRoutes);
app.use('/api/pyq-questions', pyqQuestionRoutes);
app.use('/api/study-plan-sessions', studyPlanSessionRoutes);

// Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
