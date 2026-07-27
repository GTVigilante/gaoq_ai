export {
  KnowledgeDomainError,
  completeTrainingAssignment,
  createCourseVersion,
  createExamAttempt,
  createTrainingAssignment,
  publishCourseVersion,
  recordTrainingProgress,
  retireCourseVersion,
} from './training.js';
export type { CourseVersion, ExamAttempt, TrainingAssignment } from './training.js';
export {
  assignmentEvent,
  courseEvent,
  examGradedEvent,
  onboardingAttestedEvent,
} from './knowledge-events.js';
export type { KnowledgeDomainEvent } from './knowledge-events.js';
