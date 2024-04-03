import { Socket, Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import app from './app';
import path from 'path';
import fs from 'fs'
const port = process.env.PORT || 5000;
const httpServer = createServer(app);


enum RoundType {
  Trivia = 'trivia',
  SocialSipper = 'socialSipper',
  MixAndMingle = 'mixAndMingle',
}

interface Round {
  type: RoundType;
  content: Question | string | null;  
}


interface Question {
  question: string;
  options: string[];
  correctIndex: number;
}

interface Questions {
  categories: {
    [category: string]: Question[];
  };
}

interface PlayerScore {
  userId: string | null; // Allow userId to be null or string
  score: number;
}

const playerScores: { [key: string]: number } = {};
const categories = ["History", "Science", "Geography", "Literature", "Pop Culture", "Sports", "Mythology"];
const currentQuestions = new Map<string, Question>();
const nicknameToUserId = new Map<string, string>();
const askedQuestions = new Map<string, Set<number>>();
const currentRoundIndexes = new Map<string, number>();
const incorrectAnswers = new Map<string, Set<string>>(); // Maps room ID to a Set of user IDs who answered incorrectly
const lifelineUsage = new Map<string, Map<string, string>>(); // Maps room ID to a Map of user IDs to lifeline types used

const TARGET_SCORE = 10;
const MAX_ROUNDS = 20;

const socialSipperQuestions: string[] = [
  "If you could have any superpower, what would it be?",
  "What's your go-to karaoke song?",
  // Add more questions...
];

const mixAndMingleTasks: string[] = [
  "Find someone who shares your birth month and take a selfie.",
  "Swap an interesting fact with the person on your left.",
  // Add more tasks...
];


let questions: Questions = { categories: {} }; 

fs.readFile(path.join(__dirname, 'questions.json'), 'utf8', (err, data) => {
  if (err) throw err;
  questions = JSON.parse(data) as Questions; 
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});

function getNextRound(roomId: string): Round {
  let currentRoundIndex = currentRoundIndexes.get(roomId) || 0;
  currentRoundIndexes.set(roomId, ++currentRoundIndex);
  // Example: Introduce a bonus round every 5 trivia rounds
  if ((currentRoundIndex + 1) % 5 === 0) {
    // Alternate between Social Sipper and Mix & Mingle rounds
    const bonusRoundType = (currentRoundIndex / 5) % 2 === 0 ? RoundType.SocialSipper : RoundType.MixAndMingle;
    const content = bonusRoundType === RoundType.SocialSipper
      ? socialSipperQuestions[Math.floor(Math.random() * socialSipperQuestions.length)]
      : mixAndMingleTasks[Math.floor(Math.random() * mixAndMingleTasks.length)];

    return { type: bonusRoundType, content };
  } else {
    // Standard trivia round
    const triviaQuestion = getRandomQuestion(roomId);
    return { type: RoundType.Trivia, content: triviaQuestion };
  }
}


const getRandomCategory = () =>{
  return categories[Math.floor(Math.random() * categories.length)];
}

function getRandomQuestion(roomId: string) {
  const category = getRandomCategory();
  const categoryQuestions = questions.categories[category];

  // Get the set of asked question indices for the current room, or initialize it
  const asked = askedQuestions.get(roomId) || new Set<number>();
  askedQuestions.set(roomId, asked); // Ensure the room is initialized in the Map

  // Filter out asked questions
  const availableQuestions = categoryQuestions.filter((_, index) => !asked.has(index));

  if (availableQuestions.length === 0) {
    console.error(`No more available questions in category "${category}" for room "${roomId}".`);
    return null; // or handle this scenario appropriately
  }

  const randomIndex = Math.floor(Math.random() * availableQuestions.length);
  const selectedQuestion = availableQuestions[randomIndex];

  // Find the original index of the selected question and mark it as asked
  const originalIndex = categoryQuestions.indexOf(selectedQuestion);
  asked.add(originalIndex);

  return selectedQuestion;
}

function getCurrentQuestionForRoom(roomId: string) {
  console.log("Roomid", roomId)
  console.log(currentQuestions.get(roomId))
  const question = currentQuestions.get(roomId)
  return question
}

function checkForWinCondition(roomId: string) {
  // Check if any player has reached the target score
  for (const [userId, score] of Object.entries(playerScores)) {
    if (score >= TARGET_SCORE) {
      // Announce the winner and end the game
      io.to(roomId).emit('game_over', { winnerId: userId, score });
      return true; // Indicates the game has ended
    }
  }

  // Check if the maximum number of rounds has been reached
  const currentRoundIndex = currentRoundIndexes.get(roomId) || 0;
  if (currentRoundIndex >= MAX_ROUNDS) {
    // Find the player with the highest score
    const highestScorer = Object.entries(playerScores).reduce<PlayerScore>((acc, [userId, score]) => {
      if (acc.score < score) {
        return { userId, score }; // Now userId can be a string as per the interface
      }
      return acc;
    }, { userId: null, score: -Infinity } as PlayerScore); // Cast the initial value to the interface

    // Announce the winner by highest score and end the game
    io.to(roomId).emit('game_over', highestScorer);
    return true; // Indicates the game has ended
  }

  // No win condition met
  return false;
}

function createLeaderboard() {
  console.log('Creating leaderboard...');
  console.log('Player Scores:', playerScores);
  console.log('Nickname to UserID:', Array.from(nicknameToUserId.entries()));

  const leaderboard: { [nickname: string]: number } = {};
  for (const [userId, score] of Object.entries(playerScores)) {
    const nickname = Array.from(nicknameToUserId).find(([name, id]) => id === userId)?.[0];
    if (nickname) {
      leaderboard[nickname] = score;
    }
  }

  console.log('Generated Leaderboard:', leaderboard);
  return leaderboard;
}
const onCreateRoom = (socket: Socket) => ({ roomCode }: {roomCode: string}) => {
  console.log('Got create_room', roomCode);
  socket.join(roomCode);
  socket.emit('room_created', roomCode);
};



const onDisconnect = () => {
  console.log('User disconnected');
};


/**
 * Function that handles various socket events such as joining rooms, creating rooms, starting games, submitting answers, using lifelines, asking audience, and activating double dip.
 *
 * @param {Socket} socket - the socket object for communication
 */
const onConnection = (socket: Socket) => {
  console.log('A user connected');
  socket.on('join_room', ({ roomId, nickname }: {roomId: string, nickname: string}) => {
    socket.join(roomId);
    io.to(roomId).emit('room_joined', { roomId, userId: socket.id, nickname });
    nicknameToUserId.set(nickname, socket.id);
    console.log(`User with ID: ${socket.id} joined room: ${roomId}`);
  });
  socket.on('create_room', onCreateRoom(socket));
  socket.on('disconnect', onDisconnect);
  socket.on('start_game', ({connectedRoomId}: {connectedRoomId: string}) => {
    io.to(connectedRoomId).emit("game_started");
    const question = getRandomQuestion(connectedRoomId);
    currentQuestions.set(connectedRoomId, question);
    io.to(connectedRoomId).emit("send_question", {question});
    setTimeout(() => {
      io.to(connectedRoomId).emit('times_up');
      const leaderboard = createLeaderboard(); // Create the leaderboard
      io.to(connectedRoomId).emit('leaderboard', leaderboard); // Emit the leaderboard
      const incorrectNicknames = Array.from(incorrectAnswers.get(connectedRoomId) || []).map(userId => nicknameToUserId.get(userId));
      const lifelineNicknames = Array.from(lifelineUsage.get(connectedRoomId) || new Map()).map(([userId, lifeline]) => ({
        nickname: nicknameToUserId.get(userId),
        lifeline
      }));
    
      io.to(connectedRoomId).emit('question_summary', { incorrectNicknames, lifelineNicknames });
    
      // Clear the tracking Maps for the next question
      incorrectAnswers.delete(connectedRoomId);
      lifelineUsage.delete(connectedRoomId);
    }, 10000);
  });
  socket.on('next_question', ({connectedRoomId}: {connectedRoomId: string}) => {
    const round = getNextRound(connectedRoomId);
  
    // Set the current round for the room
    currentQuestions.set(connectedRoomId, round);
  
    if (round.type === RoundType.Trivia) {
      io.to(connectedRoomId).emit("send_question", { question: round.content });
    } else {
      io.to(connectedRoomId).emit("send_round", round);
    }
  
    setTimeout(() => {
      io.to(connectedRoomId).emit('times_up');
      const leaderboard = createLeaderboard();
      io.to(connectedRoomId).emit('leaderboard', leaderboard);
      const incorrectNicknames = Array.from(incorrectAnswers.get(connectedRoomId) || []).map(userId => nicknameToUserId.get(userId));
      const lifelineNicknames = Array.from(lifelineUsage.get(connectedRoomId) || new Map()).map(([userId, lifeline]) => ({
        nickname: nicknameToUserId.get(userId),
        lifeline
      }));
    
      io.to(connectedRoomId).emit('question_summary', { incorrectNicknames, lifelineNicknames });
    
      // Clear the tracking Maps for the next question
      incorrectAnswers.delete(connectedRoomId);
      lifelineUsage.delete(connectedRoomId);
  
      // Check if the game should end based on win conditions
      if (checkForWinCondition(connectedRoomId)) {
        console.log('Game over due to win condition.');
        io.to(connectedRoomId).emit('game_over');
        io.to(connectedRoomId).emit('leaderboard', createLeaderboard());
        currentQuestions.delete(connectedRoomId);
        
      } else {
        // If the game is not over, you could automatically start the next round here
        console.log('No winner yet, proceeding to next round.');
      }
    }, 10000);
  });
  
  socket.on('submit_answer', ({ connectedRoomId, userId, answer }) => {
    const question = getCurrentQuestionForRoom(connectedRoomId);
    const isCorrect = question && question.correctIndex === answer;
    let incorrectSet = incorrectAnswers.get(connectedRoomId);
    if (!incorrectSet) {
      incorrectSet = new Set<string>();
      incorrectAnswers.set(connectedRoomId, incorrectSet);
  }
  
    if (!playerScores[userId]) playerScores[userId] = 0;
  
    if (isCorrect) {
      playerScores[userId] += 1; // Adjust scoring as needed
    } else {
      // Player got the answer wrong, so add them to the incorrectAnswers Map
      if (userId) { // Check if userId is not undefined
          incorrectSet.add(userId);
      } else {
          console.error('UserId not found for nickname');
      }
    }
  
    // Emit immediate feedback to the player (optional)
    socket.emit('answer_validation', { isCorrect });
  });
  
  socket.on('lifeline_50_50', ({ roomId, userId }) => {
    let userLifelines = lifelineUsage.get(roomId);
    if (!lifelineUsage.has(roomId)) {
      lifelineUsage.set(roomId, new Map());
    }
    if (!userLifelines) {
      userLifelines = new Map<string, string>();
      lifelineUsage.set(roomId, userLifelines);
  }
  userLifelines.set(userId, '50/50');
    const currentQuestion = getCurrentQuestionForRoom(roomId);
    if (currentQuestion) {
      console.log("lifeline_50_50", currentQuestion);
      // Randomly keep one incorrect option
      const incorrectIndices = currentQuestion.options.map((_, index) => index).filter(index => index !== currentQuestion.correctIndex);
      const keepIndex = incorrectIndices[Math.floor(Math.random() * incorrectIndices.length)];
  
      // Filter options to only include one incorrect and the correct one
      const newOptions = currentQuestion.options.filter((_, index) => index === currentQuestion.correctIndex || index === keepIndex);
  
      // Emit the modified question back to the user
      console.log("new options", newOptions)
      io.to(socket.id).emit('modified_question', { ...currentQuestion, options: newOptions });
    }else {
      console.log("no current question")
    }
  });
// Temporary store for answers
const questionAnswers = new Map<string, number[]>(); // Maps question ID to array of chosen option indices

socket.on('ask_audience', ({ roomId }) => {
  const currentQuestion = getCurrentQuestionForRoom(roomId);
  if (currentQuestion) {
    const answers = questionAnswers.get(roomId) || [];
    const aggregatedAnswers = answers.reduce<{ [key: number]: number }>((acc, curr) => {
      acc[curr] = (acc[curr] || 0) + 1;
      return acc;
    }, {});

    io.to(socket.id).emit('audience_answers', aggregatedAnswers);
  }
});

const playerAttempts = new Map<string, { attempts: number, usedDoubleDip: boolean }>();

socket.on('submit_answer', ({ roomId, answer }) => {
  const playerData = playerAttempts.get(socket.id) || { attempts: 0, usedDoubleDip: false };
  const currentQuestion = getCurrentQuestionForRoom(roomId);
  if (currentQuestion) {
    const isCorrect = currentQuestion.correctIndex === answer;
    playerData.attempts++;

    if (isCorrect || playerData.attempts >= 2 || !playerData.usedDoubleDip) {
      // Handle answer (correct or second attempt)
      if (isCorrect) {
        // Adjust score based on attempt
        const scoreAdjustment = playerData.attempts === 1 ? 1 : 0.5; // Example scoring logic
        playerScores[socket.id] = (playerScores[socket.id] || 0) + scoreAdjustment;
      }

      // Reset attempts and usedDoubleDip flag for next question
      playerAttempts.set(socket.id, { attempts: 0, usedDoubleDip: false });

      // Emit result back to player
      io.to(socket.id).emit('answer_result', { isCorrect, attempts: playerData.attempts });
    }
  }
});

// Listen for Double Dip activation
socket.on('activate_double_dip', () => {
  const playerData = playerAttempts.get(socket.id) || { attempts: 0, usedDoubleDip: false };
  playerData.usedDoubleDip = true;
  playerAttempts.set(socket.id, playerData);
});

};



io.on('connection', onConnection);

httpServer.listen(port, () => {
  console.log(`Listening: http://localhost:${port}`);
}).on('error', (error) => {
  console.error('Failed to start server:', error);
});


