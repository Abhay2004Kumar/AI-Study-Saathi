const dotenv = require('dotenv');
const joi = require('joi');

// Load env vars
dotenv.config();

// Define validation for all the env vars
const envVarsSchema = joi.object({
  NODE_ENV: joi.string()
    .allow('development', 'production', 'test')
    .default('development'),
  PORT: joi.number()
    .default(3000),
  JWT_SECRET: joi.string()
    .required()
    .description('JWT Secret Key'),
  JWT_EXPIRES_IN: joi.string()
    .default('7d')
    .description('JWT Expiration Time'),
  GEMINI_API_KEY: joi.string()
    .required()
    .description('Google Gemini API Key'),
}).unknown()
  .required();

const { error, value: envVars } = envVarsSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  jwt: {
    secret: envVars.JWT_SECRET,
    expiresIn: envVars.JWT_EXPIRES_IN,
  },
  gemini: {
    apiKey: envVars.GEMINI_API_KEY,
  },
};
