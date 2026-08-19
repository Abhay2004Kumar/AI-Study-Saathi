const EmbeddingService = require('../src/ai/services/embedding.service');

describe('Embedding Service', () => {
  // Since the user provided a real GEMINI_API_KEY, this will make a live API call to Google.
  // We'll set a higher timeout just in case the API is slow.
  jest.setTimeout(10000);

  it('should generate an embedding vector for a piece of text', async () => {
    const text = 'Deadlock occurs when processes wait indefinitely for resources held by each other.';
    
    console.log(`Generating embedding for text: "${text}"`);
    
    const vector = await EmbeddingService.generateEmbedding(text);
    
    // An embedding should be an array of numbers
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBeGreaterThan(0);
    
    // Typically Gemini models produce 768 or 3072 dimensions
    expect(vector.length).toBe(3072);
    
    // Check that it's actually numbers
    expect(typeof vector[0]).toBe('number');

    console.log(`Successfully generated embedding with ${vector.length} dimensions!`);
    console.log(`First 5 dimensions: [${vector.slice(0, 5).join(', ')}...]`);
  });

  it('should generate multiple embeddings', async () => {
    const texts = [
      'What is an operating system?',
      'An OS manages computer hardware and software resources.',
    ];
    
    const vectors = await EmbeddingService.generateEmbeddings(texts);
    
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBe(2);
    expect(vectors[0].length).toBe(3072);
    expect(vectors[1].length).toBe(3072);
  });

  it('should fail gracefully if invalid input is provided', async () => {
    await expect(EmbeddingService.generateEmbedding(null)).rejects.toThrow(/valid string/);
  });
});
