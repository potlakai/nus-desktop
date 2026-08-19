const style = require('./style');
const { api } = require('./db');

function buildProfessorEmail(request) {
  const profile = style.getProfile();
  const exemplars = style.getExemplars();
  const greeting = (profile && profile.greeting) || 'Dear';
  const signoff = (profile && profile.signoff) || 'Best regards';

  const course = request.course_name && request.course_code
    ? `${request.course_name} (${request.course_code})`
    : request.course_name || request.course_code || 'your course';
  const section = request.section ? `, section ${request.section}` : '';
  const address = request.preferred_address || request.professor_name || 'Professor';
  const helpType = request.help_type || 'other';

  const subjectLines = {
    extension: `Extension request for ${request.course_code || course}${section}`,
    'missing-attendance': `Missed class in ${request.course_code || course}${section}`,
    'grade-question': `Question about my grade in ${request.course_code || course}${section}`,
    'office-hours': `Office hours appointment request, ${request.course_code || course}${section}`,
    'concept-help': `Help with ${request.course_name || course} material`,
    other: `Student question regarding ${request.course_code || course}${section}`,
  };
  const subject = subjectLines[helpType] || `Student question regarding ${course}`;

  const opening = `${greeting} ${address},`;

  const introLines = [
    `I hope this finds you well.`,
    `I am a student in your ${course}${section} this semester.`,
  ].join(' ');

  let bodySection;
  switch (helpType) {
    case 'extension':
      bodySection = `I am writing to ask whether a short extension might be possible on an upcoming assignment. I have been working through the material and want to submit work that reflects what I actually understand rather than rushing a partial attempt.`;
      break;
    case 'missing-attendance':
      bodySection = `I was unable to attend a recent class meeting and want to make sure I stay current with the material and any in-class expectations I missed.`;
      break;
    case 'grade-question':
      bodySection = `I would like to ask a question about my current grade in the course so I can understand where I stand and what I should focus on for the remainder of the semester.`;
      break;
    case 'office-hours':
      bodySection = `Would it be possible to schedule a short office-hours appointment? I have a few questions that would be easier to work through in person or over a brief call.`;
      break;
    case 'concept-help':
      bodySection = `I am working through a concept in the course that has not fully clicked for me yet, and I would value your guidance on where to focus.`;
      break;
    default:
      bodySection = `I wanted to reach out about something in your course and would appreciate your guidance.`;
  }

  let excuseSection = '';
  if (request.excuse) {
    excuseSection = `\n\nTo be transparent about context: ${request.excuse}. I am sharing this so you have the full picture, not to ask for special treatment beyond what your syllabus allows.`;
  }

  let notesSection = '';
  if (request.notes) {
    notesSection = `\n\nAdditional context: ${request.notes}`;
  }

  const syllabusSection = `If there is a specific process your syllabus asks students to follow for this kind of request, please let me know and I will follow it exactly. I have reviewed the syllabus and want to respect the preferences you set out there.`;

  const closingLines = [
    `Thank you for your time, and for the course.`,
    `${signoff},`,
    String(request.student_name || '').trim() || '[Your name]',
  ].join('\n');

  const draft = [
    `Subject: ${subject}`,
    '',
    opening,
    '',
    introLines,
    '',
    bodySection,
    excuseSection,
    notesSection,
    '',
    syllabusSection,
    '',
    closingLines,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { draft, subject, style_used: profile && profile.ready, exemplars_available: exemplars.length };
}

module.exports = { buildProfessorEmail };