# AmigosNest 🚀

AmigosNest is an AI-powered learning companion for families. Parents can upload textbooks, worksheets, PDFs and other learning materials. AmigosNest generates personalized lessons, quizzes and explanation tailored to each child's learning level.

The application uses RAG to understand uploaded content and provide contextual, age-appropriate learning experiences.

## Problem

Traditional learning platforms often provide static content and one-size-fits-all experiences.

Children learn differently:

* Different learning speeds
* Different interests
* Different styles of understanding

MiloLearn aims to create adaptive learning experiences that respond to each child's needs.

## Features

* AI-powered educational assistance
* Interactive question-answer experience
* Personalized learning flow
* Child-friendly interface
* Retrieval-Augmented Generation (RAG)
* Semantic search with embeddings
* Context-aware AI responses

## Tech Stack

### Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS

### AI Stack

* Ollama
* Mistral
* Nomic Embed Text
* RAG pipeline

### Development

* Git
* GitHub

## How It Works

1. Educational content is processed and indexed
2. Content is converted into vector embeddings
3. User questions are transformed into embeddings
4. Similar content is retrieved
5. Relevant context is sent to the AI model
6. AI generates personalized responses

## Installation

Clone the repository:

```bash
git clone https://github.com/veeragandhi/MiloLearn.git
```

Install dependencies:

```bash
npm install
```

Start Ollama:

```bash
ollama serve
```

Pull required models:

```bash
ollama pull mistral
ollama pull nomic-embed-text
```

Run the application:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Future Roadmap

* Voice interactions
* Gamification and rewards
* Parent dashboard
* Progress tracking
* Personalized learning paths
* Multiple languages
* Quiz generation

## Screenshots

Add screenshots and demo GIFs here.

## Security

Do not commit:

* .env
* API keys
* Secrets
* Credentials

## Vision

Build an AI-native learning platform that helps children learn in a personalized and engaging way.

## Author

Veera Gandhi

## Application Screenshots



