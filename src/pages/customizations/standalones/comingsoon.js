import React, { useState } from 'react';

const ComingSoon = () => {
    const [email, setEmail] = useState('');
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = e => {
        e.preventDefault();
        if (email) {
            // Logic for newsletter signup or database entry goes here
            console.log('Email submitted:', email);
            setSubmitted(true);
        }
    };

    const styles = {
        container: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            width: '100vw',
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textAlign: 'center',
            padding: '20px',
        },
        title: {
            fontSize: '3rem',
            fontWeight: '800',
            marginBottom: '1rem',
            letterSpacing: '-0.025em',
        },
        subtitle: {
            fontSize: '1.25rem',
            color: '#94a3b8',
            maxWidth: '600px',
            marginBottom: '2rem',
        },
        form: {
            display: 'flex',
            gap: '10px',
            width: '100%',
            maxWidth: '400px',
        },
        input: {
            padding: '12px 16px',
            borderRadius: '8px',
            border: '1px solid #334155',
            backgroundColor: '#1e293b',
            color: 'white',
            flexGrow: 1,
            fontSize: '1rem',
        },
        button: {
            padding: '12px 24px',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: '#3b82f6',
            color: 'white',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'background-color 0.2s',
        },
        successMessage: {
            color: '#4ade80',
            fontWeight: '500',
        },
    };

    return (
        <div style={styles.container}>
            <h1 style={styles.title}>Something Big is Coming</h1>
            <p style={styles.subtitle}>
                We're working hard to bring you a brand new experience. Sign up to be the first to know when we launch.
            </p>

            {!submitted ? (
                <form style={styles.form} onSubmit={handleSubmit}>
                    <input
                        type='email'
                        placeholder='Enter your email'
                        style={styles.input}
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                    />
                    <button
                        type='submit'
                        style={styles.button}
                        onMouseOver={e => (e.target.style.backgroundColor = '#2563eb')}
                        onMouseOut={e => (e.target.style.backgroundColor = '#3b82f6')}
                    >
                        Notify Me
                    </button>
                </form>
            ) : (
                <div style={styles.successMessage}>Thanks! We'll be in touch soon.</div>
            )}

            <footer style={{ marginTop: '3rem', fontSize: '0.875rem', color: '#64748b' }}>
                &copy; {new Date().getFullYear()} Your Brand Name.
            </footer>
        </div>
    );
};

export default ComingSoon;
