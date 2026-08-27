const Joi = require('joi');

// `id` is optional everywhere: absent on new nodes (create), present when the
// client is editing an existing node so PUT /:id/syllabus can keep its id
// stable instead of recreating it (later phases attach resources to a
// specific Topic/Subtopic, so ids must survive syllabus edits).
const subtopicSchema = Joi.object({
  id: Joi.string().uuid().optional(),
  name: Joi.string().trim().min(1).max(150).required(),
  description: Joi.string().allow('', null).max(2000).optional(),
});

const topicSchema = Joi.object({
  id: Joi.string().uuid().optional(),
  name: Joi.string().trim().min(1).max(150).required(),
  description: Joi.string().allow('', null).max(2000).optional(),
  subtopics: Joi.array().items(subtopicSchema).default([]),
});

const subjectSchema = Joi.object({
  id: Joi.string().uuid().optional(),
  name: Joi.string().trim().min(1).max(150).required(),
  description: Joi.string().allow('', null).max(2000).optional(),
  topics: Joi.array().items(topicSchema).default([]),
});

const createExamSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().allow('', null).max(2000).optional(),
  examDate: Joi.date().iso().optional(),
  availableHoursPerDay: Joi.number().positive().max(24).optional(),
  metadata: Joi.object().unknown(true).optional(),
  subjects: Joi.array().items(subjectSchema).default([]),
});

const updateExamSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200).optional(),
  description: Joi.string().allow('', null).max(2000).optional(),
  examDate: Joi.date().iso().allow(null).optional(),
  availableHoursPerDay: Joi.number().positive().max(24).allow(null).optional(),
  metadata: Joi.object().unknown(true).optional(),
}).min(1);

const replaceSyllabusSchema = Joi.object({
  subjects: Joi.array().items(subjectSchema).required(),
});

const extractSyllabusSchema = Joi.object({
  text: Joi.string().max(50000).allow('').optional(),
});

const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: true });
  if (error) {
    return res.status(400).json({ success: false, message: error.details[0].message });
  }
  req.body = value;
  next();
};

module.exports = {
  validateCreateExam: validate(createExamSchema),
  validateUpdateExam: validate(updateExamSchema),
  validateReplaceSyllabus: validate(replaceSyllabusSchema),
  validateExtractSyllabus: validate(extractSyllabusSchema),
};
